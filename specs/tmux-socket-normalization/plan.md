# Plan: tmux socket normalization

> Derived from `spec.md`. Does not contradict `spec.md` or
> `specs/constitution.md`. The root `PLAN.md` carries the same design with the
> session bindings (base commit, installed binary SHA-256, worktree).

## Approach

Introduce one validated identity — an absolute tmux socket path resolved once at
launch and persisted on `RunManifest` — and force every server-contacting tmux
invocation in the product through a single composer that cannot omit it. The
alternative of keeping ambient resolution and "just being careful" is what
shipped this defect: ten files build tmux argv today and none of them can tell
which server they reached. A label (`-L`) was rejected because tmux re-resolves
it against `TMUX_TMPDIR` at each invocation, so it stays ambient-dependent. The
second half of the fix is semantic: a cross-socket miss must become `unknown`,
never `dead`, because three consumers currently convert that miss into a
destructive action.

## Sequence

1. **Chokepoint and validation first.** Add
   `loop-fork/src/loop/tmux-socket.ts` with the branded socket value,
   `TmuxTarget`, `OwnedPaneTarget`, `resolveTmuxSocket`, the target-bound
   composition trio `targetArgv` / `paneArgv` / `serverArgv` (socket-only
   `tmuxArgv` stays module-private), `tmuxAttachCommand`,
   `TmuxSocketUnknownError`, and `TmuxTargetProvenanceError`. Prove the resolver
   and validator with focused tests before any consumer depends on them.
   Nothing else can be correct first.
2. **Manifest schema.** Add `tmuxSocket` to `RunManifest` /
   `RunManifestInput`, the creation/update paths, and the `run-state.ts` read
   path with `tmuxSocket`/`tmux_socket` compatibility and canonical writes.
   Round-trip tests before any consumer reads it.
3. **Early launch binding.** Resolve once, before the early manifest
   reservation, and persist with the deterministic session identity. This
   ordering is load-bearing: resolving later would allow a durable
   active-looking run with no or an unusable socket.
4. **Launch/resume/attach and shared bounded control.** Migrate `tmux.ts` and
   `tmux-control.ts`. Shared liveness APIs stop accepting a bare session.
5. **Remaining consumer bands, one band at a time.** Bridge; GC and cleanup;
   reservation, proxy, and options; panel; Governess pane effects, handover,
   replay. Run the band's focused tests and the derived inventory after each
   band. Do not leave a mixed ambient/explicit intermediate marked complete.
6. **Derived migration check.** Add the script, wire it into
   `scripts/verify.sh`, and prove non-vacuity against seeded temporary source
   trees for the Bun-array, Node command/args, and `install.ts` forms, plus the
   three API-shape rules that keep step 1's boundaries real: private `tmuxArgv`
   never imported or re-exported outside the module, no target-naming flag in
   an argv literal outside the module, and no pane-effecting signature taking a
   bare pane id.
7. **Smoke shim migration, before any smoke that could contact a host server.**
   Verify `-S` over `-L` precedence empirically first, then move every call
   site to absolute `LOOP_TMUX_SOCKET` plus inspector `tmux -S`.
8. **Two-server certification.** Trap installed before setup; provenance,
   per-consumer evidence, destructive non-effects, positive control, cleanup,
   zero-survivor proof.
9. **Full verification.** Affected existing smokes, sequential suite,
   build/type/lint, dependency-map refresh, no-mutation comparison. A different
   evaluator writes `eval.json`; then governed `scripts/verify.sh`.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Socket form | Absolute `-S <path>` | `-L` is re-resolved against ambient `TMUX_TMPDIR` per invocation, so it does not close the defect |
| Resolution timing | Once at launch, then persisted | Any consumer that recomputes from environment reintroduces the split; the manifest becomes the single source of truth |
| Legacy verdict | `unknown`, never `dead` | Nonzero-exit-means-dead is the destructive half of the defect; `unknown` must block destructive paths |
| `$TMUX` inheritance | Honoured at launch only | Launching from inside a server is an intentional override; silently re-reading `TMUX_TMPDIR` in a consumer is the bug |
| Identity shape | Opaque `TmuxTarget`, no public constructor, built only by `targetFromManifest(handle)` — one parameter, an opaque `ManifestHandle` | Two loose parameters let a migration add `-S` while still passing the wrong run's socket. Branding the socket is not enough: a *valid* socket can still be paired with another run's session, and no static check can prove runtime provenance. With one parameter and no socket parameter anywhere public, the wrong-run pairing is not constructible rather than merely discouraged |
| Composition surface | Target-bound `targetArgv` / `paneArgv` / `serverArgv`; socket-only `tmuxArgv` module-private and unexported | `tmuxArgv(socketB, ["has-session", "-t", sessionA])` type-checks, so an exported socket-only composer is a loose seam that reintroduces the defect one layer down. The exported forms own every target-naming flag and reject caller-supplied `-S`/`-t`/`-s` |
| Skip observability | Structured `TmuxSkipRecord` to an injected sink | An unstructured log line is untestable and can vanish in production, which makes the fail-closed skip a fail-open again. Never inferred by scraping rendered terminal output |
| Persisted pane fields | Stay subordinate to `(socket, session)`; cleared atomically, not socket-qualified; reached only through opaque `OwnedPaneTarget` | A pane ID is only meaningful within a target. Subordination stated as prose is caller discipline — `(target: TmuxTarget, paneId: string)` still pairs target A with pane B. `paneTargetFromManifest(handle, field)` as the sole constructor makes that pairing a compile error, and makes atomic clearing the second line of defence rather than the only one |
| Migration enforcement | Derived check in `scripts/verify.sh` | A hand-written file list goes stale; the check reads the source and must fail on seeded violations |
| Regression shape | Producer-backed, two real servers | A single-server test cannot observe this defect at all — that is why it shipped |
| Panel scope | Union of valid manifest sockets only | Adding an ambient default reintroduces guessing and can merge same-name sessions |
| Attach hints | Qualified or explicitly absent | An unqualified hint is the non-attachable instruction the defect names |
| `install.ts` | Out of scope; `tmux -V` is the sole audited exception | Forcing launch-time socket resolution into installation is a false dependency and improves nothing |

## Affected subsystems

Named against the subsystems declared in `docs/dependency-map.md` at
`ddf134b9`. That map declares no separate run-state, panel, or lifecycle-cleanup
subsystem, so those modules sit inside `[CLI and tmux]` today. Refresh the map
with `scripts/refresh-dependency-map.sh` after the identity and schema changes,
inspect the diff, and include it in verification; the refresh is expected to add
the socket identity seam to the cross-cutting and blast-radius tables.

- **`[CLI and tmux]`** — the bulk of the change.
  - `run-state.ts`: new persisted `tmuxSocket` field, read compatibility,
    canonical write. Schema seam consumed by every band below.
  - `tmux.ts`: resolution, early binding, resume/reattach, attach hint
    formatting, all pane and buffer operations.
  - `tmux-control.ts`: liveness API changes from bare session to target;
    `unknown` semantics.
  - `claude-config-gc.ts`, `run-process-cleanup.ts`: skip on unknown with an
    observable record; cleanup becomes server-scoped and keys by
    `(socket, session)`.
  - `launch-reservation.ts`, `codex-tmux-proxy.ts`, `paired-options.ts`: refuse
    on unknown; proxy preserved on unknown.
  - `panel.ts`: enumeration over the union of valid manifest sockets, qualified
    rows, partial/unknown evidence on a failed socket query.
  - New `tmux-socket.ts` chokepoint module.
- **`[Bridge]`** (`bridge-runtime.ts`, `bridge-store.ts`) — capture/send/buffer
  paths; `BridgeStatus` schema gains socket/known-target state; delivery stays
  durably queued on unknown. Per the map's blast-radius row for bridge tool
  schema, agent MCP config, bridge tests, and prompt guidance are also checked.
- **`[Governess]`** (`governess.ts`, `governess-pane-liveness.ts`,
  `governess-replay.ts`, `governess-handoff.ts`, `governess-exit.ts`) — pane
  ownership revalidation includes socket; handover and replay carry or resolve
  the replacement target's socket.
- **Not a declared subsystem, but in scope:** `evals/smoke/` shim migration from
  `-L` to absolute `LOOP_TMUX_SOCKET`; `scripts/` derived migration check wired
  into `scripts/verify.sh`; `install.ts` as an audited exception only, behavior
  unchanged and proven unchanged.
- **Explicitly untouched:** `[Delegation policy]`, `[Utility control]`,
  `[Shared Pi runtime]`, `[Legacy provider adapter]`, `[Utility tool broker]`,
  `[Native fallback control]`. None of them builds a tmux argv or consumes
  `tmuxSession`.

## Risks

- **Smoke shim defeat (highest)** — once the product emits `-S`, the existing
  `-L` shim is superseded and the smokes would touch the operator's real tmux
  server. **Confirmed by measurement, not inference**: `tmux -L <label> -S
  <path> start-server` on tmux 3.7b created `<path>` and never created the
  label-derived path at all. → Mitigation: each smoke asserts the socket file it
  created is the one the product used, so a defeated shim fails loudly instead
  of silently.
- **Panel enumeration scope** — `list-sessions` is server-scoped and cannot span
  sockets. → Mitigation: enumerate only valid manifest sockets, render legacy
  rows as unknown, and cover both failure directions (hidden run, merged
  same-name rows) with same-name A/B tests.
- **Socket path length** — long `/private/tmp/...` worktree paths plus a socket
  suffix approach the 104-byte Darwin `sun_path` limit. → Mitigation:
  launch-time UTF-8 byte-length budget check that fails before reservation
  rather than at first connect.
- **Manifest forward-compatibility** — an older installed binary reading
  `tmuxSocket` should ignore an additive field, but that is inference. →
  Mitigation: compatibility check with the pinned installed binary against a
  copied non-product fixture only; never pointed at live product runs.
- **Handover identity drift** — replacement sessions persist only a name today,
  so replay can accept or kill the wrong server when sockets differ. →
  Mitigation: make the replacement target durable or resolve it from the
  replacement producer manifest, with same-name two-server coverage.
- **Quoting and API drift** — absolute paths may contain spaces, commas, and
  shell metacharacters, and argv execution and human hints quote differently. →
  Mitigation: central helpers plus round-trip tests on both paths.
- **Mixed intermediate state** — a partially migrated tree emits `-S` from some
  call sites and ambient from others, which is harder to reason about than
  either end state. → Mitigation: band-by-band migration with the derived
  inventory run after each band; no band is marked complete while mixed.

## Not doing

- The `install.ts` symlink-output defect, per the assignment. No install
  output, alias, symlink, or copy behavior changes.
- Recovering socket identity for runs launched before this change. They are
  deliberately unmanageable by the new binary until they exit; guessing an
  ambient socket for them is the defect, not a migration path.
- Adding the ambient default to panel enumeration as a discovery fallback.
- Any modification to product `loop-fork/runs/`, and any inspection, signal, or
  mutation of Harvto.
- Deploying, installing, merging, or pushing. The task stops at the review gate.
