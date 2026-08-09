# Tasks: tmux socket normalization

> Each task is bounded and independently implementable in this worktree.
> Tasks must not reference chat context. Verify numbers below refer to the
> numbered checks in `verify.md`.
> ~~**Nothing in this list starts before the approval gate in T-00 clears.**~~
> **T-00 CLEARED 2026-08-08** — peer review round 3 PASS plus explicit founder
> approval of the legacy-manifest support impact. T-01 is the next task and
> **must run before T-12 or any smoke that could contact a host tmux server.**
> Approval covers implementation only: merge, rebase, push to `main`, install,
> deploy, cleaning product `loop-fork/runs/`, and Harvto access each still need
> their own decision.

## Checklist

- [x] **T-00** Approval gate — peer review of the bundle, then human approval.
      **CLEARED 2026-08-08**; evidence in `runs/tmux-socket-normalization/approval.md`.
- [ ] **T-01** `-S` over `-L` precedence, verified empirically and recorded.
- [ ] **T-02** `tmux-socket.ts` chokepoint: validation, resolver, argv, attach.
- [ ] **T-03** Manifest schema: `tmuxSocket` on read, write, and update paths.
- [ ] **T-04** Early launch binding before manifest reservation.
- [ ] **T-05** Migrate launch/resume/attach and shared bounded control.
- [ ] **T-06** Migrate bridge paths and `BridgeStatus`.
- [ ] **T-07** Migrate `claude-config-gc` and `run-process-cleanup`.
- [ ] **T-08** Migrate reservation, proxy, and paired options.
- [ ] **T-09** Migrate panel enumeration and row rendering.
- [ ] **T-10** Migrate Governess pane effects, handover, and replay.
- [x] **T-11** Derived migration check plus seeded non-vacuity proof.
- [ ] **T-12** Smoke shim migration to absolute `LOOP_TMUX_SOCKET`.
- [ ] **T-13** Producer fixture capture and provenance index.
- [ ] **T-14** Two-server certification smoke with trap and survivor proof.
- [ ] **T-15** Installed-binary forward-compatibility check.
- [ ] **T-16** Full verification, dependency map, no-mutation evidence.
- [ ] **T-17** Independent evaluator writes `eval.json`; governed verify.
- [ ] **T-18** Commit, request exact-SHA review, stop at the gate.

---

## Fail-closed coverage inventory

Independent source sweep from peer review, recorded here so the per-band tasks
are checked against exact locations rather than against a band name. Every site
below must end with unknown-skip / no-effect behaviour and, where it skips, an
asserted `TmuxSkipRecord`.

| File | Lines |
|---|---|
| `codex-tmux-proxy.ts` | 81, 219, 392 |
| `claude-config-gc.ts` | 36, 72 |
| `paired-options.ts` | 52, 64 |
| `governess-replay.ts` | 60, 64, 307, 325 |
| `launch-reservation.ts` | 33 |
| `governess.ts` | 362, 364, 397-398, 4962-5029, 6485, 6570-6574 |
| `governess-pane-liveness.ts` | 72, 180 |
| `bridge-runtime.ts` | 704-786, 1101, 1164 |
| `tmux.ts` | 1070-1140, 1364, 1405, 1663, 1696, 1709, 1727, 1760, 1779, 1795, 1831, 1884, 1895, 1936, 1946, 3077-3094, 3575, 3717-3729, 3827, 3841, 3916 |
| `run-state.ts` | the seven persisted pane fields, 124-132 and 217-225 |

The same sweep confirmed **no fifth identity convention** beyond the four
documented in `spec.md`, and confirmed `sessionRef` is transcript identity and
correctly excluded.

This inventory is an aid, not the enforcement mechanism. The derived check
(T-11) remains the thing that must catch a missed site, because this list will
go stale the moment the source moves.

## Task detail

### T-00 — Approval gate

**Goal:** The bundle is peer-reviewed and human-approved before any source,
test, smoke, script, docs, or run-eval change.
**Files:** `specs/tmux-socket-normalization/{spec,plan,tasks,verify}.md`,
root `PLAN.md`, root `status.md`.
**Inputs:** `specs/constitution.md` operating rule "Start from spec, not chat";
`CLAUDE.md` operating-loop step 3.
**Output:** Recorded peer findings and the explicit human approval, plus
resolutions for the two open questions in `spec.md` (panel scope, legacy
manifest disposition).
**Done when:**
- [x] Peer review received and findings incorporated or explicitly rejected
      with a reason. *(Rounds 1 `6a4ed303` and 2 `2323058d` REVISE, both fully
      consumed; round 3 `e0b267ee` **PASS** at spec `d802f1f9…`, tasks
      `2bb690f0…`, verify `bc96366b…`, plan `67bfa1ae…`.)*
- [x] Both open questions have a recorded decision. *(Panel scope: enumerate
      only valid manifest sockets. Legacy disposition: fail closed, no
      recovery. Both in `spec.md` under "Resolved questions".)*
- [x] Explicit human approval obtained. *(Founder, 2026-08-08, session user
      channel: `approved — fail closed, no recovery. proceed to T-00`. Recorded
      with its provenance note in `runs/tmux-socket-normalization/approval.md`.)*
- [x] `status.md` updated from plan state to implementation state, and
      `runs/tmux-socket-normalization/` created without altering
      `loop-fork/runs/`. *(`git status --short loop-fork | wc -l` = 0; 1582-file
      baseline captured before creation, digest `2022557f…`.)*
- [x] HEAD/base SHA and installed binary SHA-256 re-verified and recorded.
      *(Base `ddf134b9…` resolves and equals HEAD; binary
      `9ca9f74fa66e1ea0dd2a1a821e0db4e000b64b84aa1903b3db40f820a5fc93f1`
      matches the pinned value; tmux 3.7b. Table in `approval.md`.)*

### T-01 — Environment probes: precedence, `$TMUX` layout, byte budget

**Goal:** The four environment facts the design rests on are measured, not read
from documentation, and the measurements are recorded as governed evidence.
**Files:** `runs/tmux-socket-normalization/environment-probes.txt` (evidence
only) and the probe script that produced it.
**Inputs:** Local `tmux -V`; a private temporary root.
**Output:** Recorded commands, tmux version, platform, and results.

**Status: already measured pre-approval, in an isolated scratchpad, results
recorded in `spec.md` under "Measured, not assumed".** Producer `tmux 3.7b`,
Darwin, ambient `TMUX` unset, zero survivors on cleanup. T-01 re-runs the same
probes from the repository once the gate clears so the evidence lands in
`runs/` under governance, and adds the Linux leg if a Linux host is available.

**Done when:**
- [ ] `tmux -L <label> -S <path> start-server` run against a temporary root;
      `<path>` exists afterwards and the label-derived path does not.
      *(Observed: confirmed — the label path was never created.)*
- [ ] `$TMUX` read inside a session on a known socket shows the exact field
      layout, and removing the final two comma-delimited fields recovers the
      socket. *(Observed: `<socket>,<pid>,<session-index>`.)*
- [ ] With a socket pathname containing a legal comma, parse-from-right
      recovers the path and the first-field parse is shown to truncate.
      *(Observed: `…/so,ck-c` truncates to `…/so` — parse-from-right is
      required, not stylistic.)*
- [ ] The Darwin byte budget is measured at the boundary.
      *(Observed: 103 succeeds, 104 fails `File name too long`.)*
- [ ] Every server is killed by explicit socket path, both paths removed, and a
      zero-survivor check runs. A bare `tmux kill-server` is never used.
- [ ] Verify 13 (precedence half) and verify 2 (Darwin boundary) are
      satisfiable from this evidence.

**This task runs first among implementation tasks.** If the precedence had been
the opposite of what `spec.md` states, T-12 and the whole smoke-hazard analysis
would change, so it must not be discovered late — which is why it was measured
before the gate rather than after it.

### T-02 — `tmux-socket.ts` chokepoint

**Goal:** One module owns socket identity and command composition.
**Files:** `loop-fork/src/loop/tmux-socket.ts`,
`loop-fork/tests/loop/tmux-socket.test.ts`.
**Inputs:** `spec.md` R2–R5.
**Output:** Branded validated absolute socket value; **opaque** `TmuxTarget
{ socket, session }` with no public constructor; opaque `OwnedPaneTarget` with
no public constructor; `targetFromManifest(handle)` and
`paneTargetFromManifest(handle, field)` as the only production constructors;
`resolveTmuxSocket(env)`; the three exported target-bound composition functions
`targetArgv` / `paneArgv` / `serverArgv`, with socket-only `tmuxArgv` kept
module-private and unexported; `tmuxAttachCommand(target)`;
`TmuxSocketUnknownError`; `TmuxTargetProvenanceError`; and the
`TmuxSkipRecord` type plus its injected recorder/sink interface.
**Done when:**
- [ ] `TmuxTarget` cannot be constructed from an independently sourced socket
      and session — assembling one is a compile-time error.
      `targetFromManifest` takes **exactly one parameter**, an opaque
      `ManifestHandle`, so no socket parameter exists anywhere in the public
      surface. An unbranded plain object throws `TmuxTargetProvenanceError` at
      runtime. The brand symbol and the socket-only `tmuxArgv` are absent from
      the module's public exports, asserted by enumerating them. Any test-only
      constructor is not exported from the production entrypoint (verify 5a).
- [ ] `OwnedPaneTarget` has no public constructor;
      `paneTargetFromManifest(handle, field)` reads the pane field from the same
      handle that yields the target and yields nothing when that handle's socket
      or session is unknown (verify 3).
- [ ] `targetArgv`, `paneArgv`, and `serverArgv` supply every target-naming flag
      themselves and reject an `args` array containing `-S`, `-t`, `-s`, or an
      `=`-joined form (verify 3, 5a).
- [ ] `TmuxSkipRecord` carries `consumer`, run identity, `session`/`pane` or
      explicit absence, `socketState` (`missing` | `invalid` | `conflicting` |
      `unknown`), `reason`, and `effectSkipped`, and is emitted to an injected
      sink rather than ambient logging (verify 8, 10).
- [ ] Precedence, comma-in-path `$TMUX` parsing, and absoluteness are proven
      (verify 1).
- [ ] Empty, relative, malformed, NUL-containing, and over-budget values are
      rejected with byte length and platform limit reported; boundary tests
      cover Darwin 103 and Linux 107 at limit and limit+1, plus a multibyte
      path over the byte limit but under the character limit (verify 2).
- [ ] Each composition function returns `["tmux", "-S", socket, ...]` and splits
      into Node `spawn` command/args without dropping `-S`.
- [ ] `tmuxAttachCommand` shell-escapes socket and session; spaces and
      metacharacters round trip as data (verify 12).
- [ ] No consumer imports it yet.

> **HARNESS-OWNER RULING, 2026-08-08 (run 14, bridge message
> `cc04ed1b-3273-4315-89d7-12749b5ef972`).** The sole constructor takes an
> optional index: **`paneTargetFromManifest(handle, field, index?)`**. For a
> scalar pane field `index` must be **absent**, and supplying one fails closed.
> For the one array-valued field `tmuxPaneRecon`, `index` is **required** and
> must be a non-negative integer in bounds; any missing, malformed, or
> out-of-range case yields no target plus the required structured skip evidence
> at the consumer. The returned opaque target stays bound to the same
> `ManifestHandle`-derived socket, session, and pane. There is still exactly one
> producer, and no public socket-only or session-plus-pane composition seam.
> This resolves the gap that R10's two-parameter shape could not address the
> Nth recon pane. Decided by the harness owner, who owns this defect and its
> release path; it is not a product-supervisor decision.

### T-03 — Manifest schema

**Goal:** The socket is durable and canonical.
**Files:** `loop-fork/src/loop/run-state.ts`,
`loop-fork/tests/loop/run-state.test.ts`.
**Inputs:** T-02 validation; `spec.md` R1.
**Output:** `tmuxSocket?: string` on `RunManifest` and `RunManifestInput`, on
creation and update paths, and on the read path; plus the `ManifestHandle` the
read path stamps, which is the sole input `targetFromManifest` accepts (R3).
**Done when:**
- [ ] The manifest read path is the **only** producer of `ManifestHandle`. Each
      handle is frozen and carries `runId`, the manifest pathname, and the
      SHA-256 of the bytes actually read. The brand is a unique symbol that is
      not exported, so no other module can mint one (verify 5a). Without a sole
      producer here, R3's unconstructibility argument has no foundation.
- [ ] Create, read, update, and unrelated-update round trips preserve canonical
      `tmuxSocket` (verify 3).
- [ ] `tmux_socket` is read only when unambiguous; a camel/snake conflict is
      explicit unknown targeting, not a coerced value.
- [ ] Invalid values become unknown targeting and are never resolved against
      cwd.
- [ ] Clearing stale tmux topology clears `tmuxSocket` atomically with
      `tmuxSession` and all seven persisted pane fields (`tmuxPaneAuPair`,
      `tmuxPaneGoverness`, `tmuxPaneLeft`, `tmuxPaneNanny`, `tmuxPaneRecon`,
      `tmuxPaneRight`, `tmuxPaneUtility`) on both `RunManifest`
      (`run-state.ts:124-132`) and `RunManifestInput` (`run-state.ts:217-225`).
      A partial clear leaving a pane target bound to a cleared socket fails
      (verify 3).

### T-04 — Early launch binding

**Goal:** Resolution happens once, before anything durable exists.
**Files:** `loop-fork/src/loop/tmux.ts`, its test file.
**Inputs:** T-02, T-03.
**Output:** Socket resolved and persisted with the deterministic session
identity at the early manifest binding.
**Done when:**
- [ ] Resolution failure occurs before manifest reservation and before any tmux
      server is contacted or created (verify 2, 4).
- [ ] Early manifest inspection shows socket bound with session before the
      first asynchronous startup boundary (verify 4).
- [ ] A failed startup retains both identities for bounded cleanup (verify 4).
- [ ] An existing socket-bearing manifest is never overwritten from ambient
      state (verify 5).

### T-05 — Launch, resume, attach, and shared bounded control

> **HARNESS-OWNER RULING, 2026-08-08 (run 14, bridge message
> `5a7e6cd3-1216-487c-84f3-ddbcfd371a11`) — LAUNCH-WINDOW COMPOSER, narrow
> exception to R3.** Implementing the non-paired option-A ruling exposed a
> contradiction: the non-paired path holds a resolved socket but has **no
> manifest**, therefore no `TmuxTarget`, while every exported composer is
> target-bound and an inline `-S` argv literal is barred by R12. As written,
> R3/verify 5a forbid both escapes. This amendment authorises exactly one.
>
> **Authorised (A2, narrowed).** A **dedicated launch-only composer** — not a
> generic socket-only seam — accepting the already validated and resolved
> `TmuxSocket` plus the non-paired session identity. It may be used **only
> before a manifest-backed target exists**.
>
> **Rejected (A1).** Minting a `TmuxTarget` outside the manifest read path is
> rejected: it would weaken provenance and create a third target producer,
> contradicting verify 5a's constructibility bound.
>
> **Invariants preserved, explicitly.**
> - `targetFromManifest` remains the **sole** post-launch `TmuxTarget` producer.
> - `targetArgv`, `paneArgv`, and `serverArgv` all remain target-bound.
> - No caller-written target flags; the composer supplies them.
> - No ambient re-resolution: the socket is resolved once and reused.
>
> **Acceptance criteria.**
> 1. Non-paired session creation **and** its attach hint are composed from the
>    **same** resolved value — one resolution, two consumers, not two
>    derivations.
> 2. The composer is unreachable from, and unimported by, every post-launch
>    consumer.
> 3. A derived/import-scope assertion, or an explicit named restriction, proves
>    the launch-only composer is not used after a manifest-backed launch.
> 4. Hostile ambient state cannot change the identity after resolution.
> 5. Resolution failure and unknown remain explicit — never a silent bare hint,
>    never the legacy-manifest wording.
>
> Bundle amended **before** any source change, per the ruling.


> **HARNESS-OWNER RULING, 2026-08-08 (run 14, bridge message
> `c3385227-657c-4f03-b2d5-4ad825ab2801`) — T-05 SCOPE EXTENSION: non-paired
> `--tmux` launches.** A `--tmux` launch without `--paired` creates a tmux
> session but has **no run manifest**, so it has no recorded socket and no
> target. Leaving its attach hint unqualified violates verify 12 and R3, and
> emitting the legacy unknown-socket line for it would be **false** — nothing
> was "recorded before socket normalization"; that path never had a manifest.
> Inventing a third hint state is also rejected.
>
> **Required behaviour.** The non-paired launch resolves its socket **once**,
> **before** the session is created or any tmux server is contacted, and carries
> that launch-time socket identity forward. It need **not** invent a manifest;
> the existing non-paired lifecycle is preserved.
>
> **Acceptance criteria.**
> 1. Resolution happens exactly once, before session creation/contact.
> 2. The **same** `-S <socket>` is used for session creation and for the
>    emitted attach hint — one resolved value, not two derivations.
> 3. Hostile ambient state (`LOOP_TMUX_SOCKET`, `TMUX`, `TMUX_TMPDIR`) cannot
>    change the identity after resolution.
> 4. Resolution failure and unknown remain **explicit** — never a silent bare
>    hint, and never the legacy-manifest wording.
> 5. Producer-path tests, including the existing non-paired launch test and a
>    **hostile-ambient decoy** assertion proving the hint still carries the
>    resolved socket.


**Goal:** The launcher and the shared liveness API stop being ambient.
**Files:** `loop-fork/src/loop/tmux.ts`,
`loop-fork/src/loop/tmux-control.ts`, their test files.
**Inputs:** T-02, T-03, T-04.
**Output:** All `tmux.ts` and `tmux-control.ts` invocations route through
`targetArgv` / `paneArgv` / `serverArgv`; liveness accepts a `TmuxTarget` or an
`OwnedPaneTarget`, never a bare session and never a socket plus a
caller-supplied `-t`.
**Done when:**
- [ ] Resume/reattach uses the persisted socket and ignores later
      `LOOP_TMUX_SOCKET`, `TMUX`, `TMUX_TMPDIR` (verify 5).
- [ ] A legacy manifest yields `"unknown"`, never `"dead"`, and blocks resume
      (verify 5, 10).
- [ ] Attach hints at `tmux.ts:3602` and `tmux.ts:4024` are qualified;
      a legacy manifest prints the explicit unknown-socket line and no command
      (verify 12).
- [ ] Timeout and error still map to `unknown`; interactive attach alone stays
      unbounded; every non-interactive command keeps a finite kill-on-timeout
      bound (verify 17).
- [ ] **Provenance, in the two parts that are checkable** (verify 5a, 5b).
      5a: the wrong-run pairing is **unconstructible** — `targetFromManifest`
      has exactly one parameter and no consumer path has a socket parameter to
      supply, asserted by `@ts-expect-error` negative type tests plus a runtime
      `TmuxTargetProvenanceError` on an unbranded object. 5b: driving every
      consumer from A's handle under hostile B ambient state emits A's socket
      and A's session on every invocation and contacts B zero times. The
      tampered-manifest residual (5c) is recorded, not asserted as a rejection.
      `resolveTmuxSocket` is unreachable from any post-launch consumer path.
- [ ] The band's focused tests and the derived inventory both run.

### T-06 — Bridge

**Goal:** Bridge targets the recorded server and publishes the target.
**Files:** `loop-fork/src/loop/bridge-runtime.ts`,
`loop-fork/src/loop/bridge-store.ts`, their test files.
**Inputs:** T-05.
**Output:** Capture, send, and buffer paths use the manifest target;
`BridgeStatus` carries `tmuxSocket`/known-target state alongside `tmuxSession`.
**Done when:**
- [ ] Delivery stays durably queued and issues no tmux command when the target
      socket is unknown, with a skip record emitted (verify 10).
- [ ] Stale-state cleanup does not clear topology on unknown (verify 9).
- [ ] `BridgeStatus` schema change is covered, and per the dependency map's
      blast-radius row, agent MCP config, bridge tests, and prompt guidance are
      checked for the contract change.

### T-07 — Config GC and process cleanup

**Goal:** The two destructive consumers stop acting on a cross-socket miss.
**Files:** `loop-fork/src/loop/claude-config-gc.ts`,
`loop-fork/src/loop/run-process-cleanup.ts`, their test files.
**Inputs:** T-05.
**Output:** `defaultTmuxSessionAlive` no longer returns `false` on a nonzero
exit for a socket-bearing manifest; `defaultListTmuxSessions` no longer maps
`no server running` to an empty set; enumeration is server-scoped and keyed by
`(socket, session)`.
**Done when:**
- [ ] `undefined`/`unknown` is do-not-touch and skips, with a
      consumer-specific record asserted by test (verify 8, 10).
- [ ] A command failure is unknown for the affected targets only (verify 11).
- [ ] Every missing/invalid-socket manifest is preserved with an observable
      reason (verify 10).
- [ ] Same session name on two sockets is not a collision (verify 11).

### T-08 — Reservation, proxy, paired options

**Goal:** The interlock and proxy fail closed.
**Files:** `loop-fork/src/loop/launch-reservation.ts`,
`loop-fork/src/loop/codex-tmux-proxy.ts`,
`loop-fork/src/loop/paired-options.ts`, their test files.
**Inputs:** T-05.
**Output:** Reservation refuses on `"unknown"`; the proxy receives the manifest
target and is preserved on unknown.
**Done when:**
- [ ] A cross-socket miss produces `"unknown"` and reservation refuses the
      launch rather than admitting a duplicate (verify 9, 10).
- [ ] The proxy does not stop and emits no `reason: "dead-tmux"` on unknown
      (verify 9).

### T-09 — Panel

**Goal:** Enumeration is server-scoped and rows are attachable or explicitly
not.
**Files:** `loop-fork/src/loop/panel.ts`, its test file.
**Inputs:** T-05.
**Output:** Enumeration over the deduplicated set of valid manifest sockets
only; qualified rows and attach hints; legacy rows unknown and non-attachable.
**Done when:**
- [ ] No ambient default is added to the enumeration set (verify 11).
- [ ] Same-named sessions on two sockets remain distinct rows (verify 11).
- [ ] One failed socket query does not erase rows from other sockets and is
      surfaced as partial/unknown evidence (verify 11).
- [ ] `panel.ts:1169` attach hint is qualified (verify 12).
- [ ] The three row states are implemented as specified (verify 11): valid
      socket + session present renders live and attachable; valid socket +
      session **absent** renders `dead` and the row is **retained, never
      omitted**; no usable socket renders `unknown`, non-attachable, and is
      never queried. "Legacy row" means a manifest-backed row rendered unknown,
      never a row discovered by querying an unknown server.

### T-10 — Governess

**Goal:** No Governess effect runs on session-only evidence.
**Files:** `loop-fork/src/loop/governess.ts`,
`loop-fork/src/loop/governess-pane-liveness.ts`,
`loop-fork/src/loop/governess-replay.ts`,
`loop-fork/src/loop/governess-handoff.ts`,
`loop-fork/src/loop/governess-exit.ts`, their test files.
**Inputs:** T-05.
**Output:** Every Governess pane effect takes an `OwnedPaneTarget` obtained from
`paneTargetFromManifest(handle, field)`; no pane-effecting signature in this
band accepts a bare `string` pane id or a `(TmuxTarget, paneId)` pair. Handover
state and replay carry or resolve the replacement target's socket instead of the
bare `replacementSession` name, at **all three** declaration sites:
`governess-handoff.ts:38,224,244`, `governess-exit.ts:14,60-63,96`, and
`governess-replay.ts:307`.
**Done when:**
- [ ] `governess-pane-liveness.ts:72,180` and every Governess pane effect accept
      only `OwnedPaneTarget`; pairing a target with a pane from a different
      manifest does not compile (verify 3). Caller discipline is not accepted as
      the enforcement mechanism for this band.
- [ ] No respawn, send, replay, teardown, or handover acceptance from
      session-only evidence, each with a skip record (verify 10).
- [ ] Governess does not kill or respawn on B-derived evidence (verify 9).
- [ ] `governess-exit.ts` no longer treats a persisted replacement *name* as
      sufficient identity.

### T-11 — Derived migration check

> **HARNESS-OWNER RULING, 2026-08-08 (run 14, bridge messages
> `7be19de0-8312-4976-a984-1c24d7ce3e75`, superseded by
> `6ab87ddc-605a-49bc-a7da-aee51aea6bb6`, `414232c9-aee3-4351-8084-e860ddc27796`,
> and `1b3caebf-a9fe-4a62-a892-c0296b732e23`).** Central `tmux-control.ts` now
> returns `"unknown"` for an absent session, but consumers reproduce the defect
> inline, so the central fix does **not** close verify 10.
>
> **No automated rule is added.** A literal `: "dead"` source pattern is a
> blacklist and is explicitly withdrawn: it misses `liveness = "dead"` and
> `? "dead"`, which is exactly how this inventory was first mis-derived as five
> sites instead of six. A value-flow rule must **not** be claimed either, because
> the current checker surface is not an AST/type-flow analyzer and cannot prove
> `TmuxLiveness` production or confirmed-missing evidence. Letting either form
> certify six-site completeness would be coverage that does not exist.
>
> **Recorded limitation.** The derived check does **not** provide full semantic
> coverage for arbitrary `TmuxLiveness` value production. This limitation is
> recorded here, in verify 6, and in the eval notes.
>
> **The honest alternative, which is what is required:** an explicit per-band
> checklist with **named per-site tests**. Each site below must be migrated to
> `"unknown"` and asserted by its own named test in its own band:
>
> | Site | Band |
> |---|---|
> | `governess-replay.ts:326` | T-10 |
> | `bridge-runtime.ts:1105` | T-06 |
> | `launch-reservation.ts:121` | T-08 |
> | `launch-reservation.ts:224` | T-08 |
> | `codex-tmux-proxy.ts:908` | T-08 |
> | `paired-options.ts:75` | T-08 |
>
> Six sites, confirmed. Any shorter file list in an earlier message was
> illustrative, not exhaustive. `paired-options.ts:75` is included and needs a
> different fix from the other five: it is already guarded against the
> absent-name case and already throws on `"unknown"`, so what remains is that
> `sessionProbe` is socket-blind and a `false` result can mean "found nothing on
> the wrong server".
>
> **`tmux.ts:1102` is excluded and is the positive model.** Its
> `isConfirmedMissingTmuxSession(stderr, …) ? "dead" : "unknown"` predicate is
> the required shape: a confirmed-missing session read from real server output
> is evidence; an absent session *name* is not. `"dead"` grants cleanup
> authority, so only confirmed evidence may produce it.
>
> **If** T-11 later introduces a real AST/type-flow analyzer, it must state its
> method, catch assignment / ternary / alias forms, include independently
> seeded indirect cases, and be reviewed separately before any completeness
> claim rests on it.
>
> Verify 10 remains **open** pending the per-consumer fixes and their skip
> records across T-06, T-08, and T-10.


**Goal:** The migration is enforced by reading the source, not by a list.
**Files:** new script under `scripts/`, `scripts/verify.sh`, and its test.
**Inputs:** T-05 through T-10 complete.
**Output:** A check that fails on Bun-array and Node command/args direct
invocations, bare-session shared-liveness calls, and unqualified attach
formatters; wired into `scripts/verify.sh`.
**Done when:**
- [x] The check passes against tracked source (verify 6).
- [x] Seeded Bun-array, Node command/args, and second-`install.ts`-invocation
      violations each fail the check **independently**, in temporary seeded
      trees and never by editing tracked source (verify 6).
- [x] The `install.ts` `tmux -V` exception matches on exact path **and** exact
      argv, so a different invocation in the same file still fails (verify 6).
- [x] The analysis method is stated. If regex-based, a seeded indirect
      helper/alias case is added and the coverage limitation is recorded; if
      AST/parser-based, that is stated and the indirect case is caught
      (verify 6).
- [x] The three API-shape rules from R12 are implemented and each is proven
      non-vacuous by its own independently nonzero seeded violation (verify 6):
      a seeded import or barrel re-export of the module-private socket-only
      `tmuxArgv` outside `tmux-socket.ts`; a seeded `-S`/`-t`/`-s` or `=`-joined
      target flag in an argv array literal outside `tmux-socket.ts`; and a
      seeded pane-effecting signature taking a bare `string` pane id or a
      `(TmuxTarget, paneId)` pair. These rules are what keep the unexported
      helper unexported and `OwnedPaneTarget` unbypassed.
- [x] The check cannot prove runtime provenance; T-05's verify 5a
      unconstructibility assertions and verify 5b cross-run non-contact cover
      what this check structurally cannot, and the verify 5c residual is
      recorded rather than claimed as covered.

**Completed 2026-08-09 in D-023.** The AST checker and 26 independent seed
tests passed; the four owning checker/tmux/bridge suites passed 274/274 with
1,161 assertions; exact scoped static analysis, build, diff check, and an
independent zero-write review passed. The review drove explicit coverage for
lexical shadowing, spread heads, namespace imports, plain and namespace export
stars, and the exact Governess-only compatibility surface. Arbitrary semantic
`TmuxLiveness` value flow remains the named-consumer-test residual described
above.

### T-12 — Smoke shim migration

**Goal:** No smoke can reach a host tmux server.
**Files:** `evals/smoke/fixtures/isolated-tmux.sh`,
`evals/smoke/large-prompt-launch.sh`,
`evals/smoke/active-launch-interlock.sh`,
`evals/smoke/paste-submit-readiness.sh`, plus any further call site found by
repository search.
**Inputs:** T-01 precedence evidence; T-05 emitting `-S`.
**Output:** Every call site sets product `LOOP_TMUX_SOCKET` to an absolute
socket path and inspects/cleans up with real `tmux -S`.
**Done when:**
- [ ] Repository search proves the old product-facing label shim is gone or no
      longer on the product's PATH (verify 13).
- [ ] Each migrated smoke asserts the socket file it created is the one the
      product actually used.
- [ ] `large-prompt-launch.sh`'s Darwin-only character-count assertion is
      replaced by the producer's byte-based property (verify 13).
- [ ] T-11 runs before any smoke that could contact a host server.

### T-13 — Producer fixture and provenance

**Goal:** Integration evidence is producer-derived, not hand-authored.
**Files:** `loop-fork/tests/fixtures/tmux-socket-normalization/` with
`fixture-index.json`, plus the normalizer script that produced it.
**Inputs:** Compiled candidate from `bun run build`.
**Output:** New-path fixture from compiled-product output, and a legacy fixture
derived from it.
**Done when:**
- [ ] Producer binary SHA-256, tmux version, capture command, UTC time,
      environment, and manifest SHA-256 are recorded (verify 14).
- [ ] The legacy fixture is generated by removing only `tmuxSocket` from
      producer output and records source and derived SHA-256 (verify 14).
- [ ] `fixture-index.json` per-file SHA-256 values match the checked-in bytes
      and the normalizer reproduces them.
- [ ] No hand-authored fixture certifies the seam alone.

### T-14 — Two-server certification smoke

**Goal:** The defect is reproduced and closed against two real servers.
**Files:** `evals/smoke/tmux-socket-normalization.sh`, plus a focused Bun
harness for consumers with no CLI surface.
**Inputs:** T-11, T-12, T-13.
**Output:** Producer-backed run on A, same-named decoy on B, consumer matrix
under hostile B ambient state, cleanup and survivor proof.
**Done when:**
- [ ] Trap is installed before any server or process is created and runs on
      success, assertion failure, and signal (verify 15).
- [ ] Server PIDs and every run-owned launcher/pane/bridge/proxy/app-server PID
      are recorded before teardown, then polled with a bounded deadline
      (verify 15).
- [ ] The zero-survivor proof fails when nothing was recorded; the positive
      control runs **before** real cleanup and the detector returns failure on a
      known-live recorded PID; the control is then cleared, cleanup runs, and
      the post-cleanup proof passes — in that order, because a control run after
      cleanup has no survivor left to detect (verify 16).
- [ ] The trap kills only recorded run-owned PIDs and never an unrelated PID;
      servers are addressed by explicit socket path and a bare
      `tmux kill-server` is never issued (verify 16).
- [ ] Post-cleanup proof: no live recorded PID, no A/B socket, no session on
      either explicit socket, no touched host or product run path (verify 16).
- [ ] Consumer matrix has named per-consumer assertions, not one shared-helper
      assertion (verify 7, 8).
- [ ] Destructive non-effects are asserted (verify 9); decoy B content is
      byte-identical before and after (verify 7).
- [ ] Consumers with no CLI surface run against the producer-written manifest
      and the same two real servers, never a hand-authored manifest.
- [ ] No installed-binary deployment occurs during certification.

### T-15 — Installed-binary forward-compatibility

**Goal:** Retire an inference in `spec.md`'s risk list.
**Files:** `runs/tmux-socket-normalization/forward-compat.txt` (evidence only).
**Inputs:** Pinned installed binary
`/Users/amgad/.local/bin/loop`, SHA-256
`9ca9f74fa66e1ea0dd2a1a821e0db4e000b64b84aa1903b3db40f820a5fc93f1`.
**Output:** Recorded behaviour of the old binary reading a manifest containing
`tmuxSocket`.
**Done when:**
- [ ] The check runs against a **copied non-product fixture only**, never a live
      product run path.
- [ ] The binary SHA-256 is re-verified at use time and recorded.
- [ ] The result states observed behaviour, not the prior inference.

### T-16 — Full verification and no-mutation evidence

**Goal:** Repository-level green with recorded scope.
**Files:** `docs/dependency-map.md`, `runs/tmux-socket-normalization/`.
**Inputs:** T-01 through T-15.
**Output:** Command transcripts and comparisons.
**Done when:**
- [ ] From `loop-fork/`: `bun run check`, the documented `bunx tsc --noEmit`
      invocation, `bun run build`, and
      `env -u TMUX -u TMUX_PANE bun run test:ci` all pass with no skipped or
      tolerated failure.
- [ ] `bash evals/smoke/large-prompt-launch.sh`,
      `bash evals/smoke/active-launch-interlock.sh`, and
      `bash evals/smoke/paste-submit-readiness.sh` pass, with exact commands and
      candidate SHA-256 recorded.
- [ ] `scripts/refresh-dependency-map.sh` run, diff inspected and included.
- [ ] Pre/post `git status --short` and hashes/mtimes of in-scope
      `loop-fork/runs/` paths compared and equal (verify 18).
- [ ] `tests/install.test.ts` proves install behavior unchanged (verify 18).
- [ ] Harvto not inspected, addressed, signalled, or mutated (verify 18).
- [ ] Touched files formatted with biome directly. `bun run fix` is **not** used
      because it rewrites `runs/` evidence.

### T-17 — Independent evaluation and governed verify

**Goal:** No self-review, per `specs/constitution.md`.
**Files:** `runs/tmux-socket-normalization/eval.json`.
**Inputs:** T-16 evidence.
**Output:** `eval.json` with `baseline_failures: []`.
**Done when:**
- [ ] A **different** agent from the implementer writes `eval.json`.
- [ ] UI checks are recorded as not applicable with the terminal-output reason.
- [ ] `scripts/verify.sh tmux-socket-normalization tmux-socket-normalization`
      passes with no tolerated-failure count and no pre-existing failure.

### T-18 — Commit and review gate

**Goal:** Hand off a reviewable candidate without shipping it.
**Files:** none beyond the scoped diff.
**Inputs:** T-17 pass.
**Output:** One scoped commit on `codex/tmux-socket-normalization-run11`.
**Done when:**
- [ ] `git diff origin/main...HEAD --name-only` contains only in-scope paths.
- [ ] `git diff --numstat` and `git diff --numstat --ignore-all-space` agree, so
      no unintended reformatting shipped.
- [ ] Explicit paths staged; never `git add -A`.
- [ ] Native Codex independent exact-SHA technical review requested.
- [ ] Supervisor exact-SHA review and joint install gate requested.
- [ ] **Stop.** No merge, rebase, push to `main`, install, or deploy. Product
      `loop-fork/runs/` not cleaned. Harvto not touched.
