# Verify: tmux socket normalization

> Evaluator contract. The evaluator agent reads this file, not the spec.
> The checks below are cited as **verify 1–18** and correspond one-to-one to the
> acceptance-criteria table in `spec.md`. They are **not** the same list as
> `spec.md`'s requirements, which are cited as **R1–R18**; that table gives the
> mapping. Never cite a bare number.
> No tolerated-failure count, pre-existing failure, or skip is accepted.

1. Assert `resolveTmuxSocket` precedence is `LOOP_TMUX_SOCKET`, then parsed
   `$TMUX`, then `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/default`, and that every
   successful result is absolute. Assert `LOOP_TMUX_SOCKET` wins when `$TMUX`
   is also set. Assert a socket pathname containing a comma inside `$TMUX` is
   preserved, by parsing from the right and removing exactly the final two
   comma-delimited tmux metadata fields. Assert an operator-exported
   `TMUX_TMPDIR` is honoured by rule three and recorded, not re-read later.

2. Assert empty, malformed, relative, NUL-containing, and over-budget launch
   values fail **before** manifest reservation and before any tmux server is
   contacted or created, so no durable active-looking run exists with an
   unusable socket. Assert the failure reports UTF-8 byte length and the
   platform limit. Byte-length boundary tests cover the Darwin limit (103
   usable pathname bytes) and the Linux limit (107), at limit and limit+1, and
   include a multibyte path whose character count is under the limit while its
   byte length is over — proving character count is not the instrument.
   Assert a relative `LOOP_TMUX_SOCKET` is a hard error and is never resolved
   against cwd, and that a malformed `$TMUX` parse is a hard error rather than
   a fallback to rule three.

3. Assert `RunManifest` create, read, and update round trips preserve canonical
   `tmuxSocket`; that an unrelated update preserves it; that snake-case
   `tmux_socket` input is accepted only when unambiguous; and that missing,
   invalid, or conflicting camel/snake socket fields become explicit unknown
   targeting rather than a silently coerced value.
   Assert **atomic topology clearing**: clearing stale tmux topology clears
   `tmuxSocket` together with `tmuxSession` and all seven persisted pane fields
   — `tmuxPaneAuPair`, `tmuxPaneGoverness`, `tmuxPaneLeft`, `tmuxPaneNanny`,
   `tmuxPaneRecon` (a `string[]`), `tmuxPaneRight`, `tmuxPaneUtility` — on both
   `RunManifest` (`run-state.ts:124-132`) and `RunManifestInput`
   (`run-state.ts:217-225`). A manifest left holding any pane target after
   `tmuxSocket` is cleared fails this check: a pane target is exactly as
   socket-dependent as a session name, so a partial clear is a new instance of
   the same defect.
   Assert **pane subordination by type** (R10). A `(TmuxTarget, paneId: string)`
   signature would leave target-A-with-pane-B pairable by any caller, so the
   assertion is about the type, not about caller behaviour. Assert
   `OwnedPaneTarget` has no public constructor and that
   `paneTargetFromManifest(handle, field)` is its only production constructor.
   Assert with `@ts-expect-error` negative type tests that a pane-effecting API
   rejects at compile time both a bare `string` pane id and a
   `(TmuxTarget, paneId)` pair; enumerate every pane-effecting signature — pane
   respawn, `send-keys`, `capture-pane`, buffer operations, pane liveness, pane
   kill — and assert each takes `OwnedPaneTarget`. Assert at runtime that
   `paneTargetFromManifest` yields nothing when the handle's socket or session
   is unknown, and that after atomic clearing every pane field on that manifest
   is unreachable — not merely absent from the file. Assert `paneArgv` supplies
   the pane's `-t` value from the owning handle and rejects a caller-supplied
   `-t` in `args`.

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

4. Assert a producer-backed completed launch writes `tmuxSocket` as the exact
   absolute socket A path and that the socket file exists. Assert by early
   manifest inspection that the socket is bound together with `tmuxSession`
   before the first asynchronous startup boundary. Assert a failed startup
   retains both identities so bounded cleanup can still target the run.

5. Assert resume/reattach targets the persisted socket. Assert a legacy active
   manifest (session, no usable socket) blocks resume and blocks a duplicate
   launch. Assert hostile consumer-side `LOOP_TMUX_SOCKET`, `TMUX`, and
   `TMUX_TMPDIR` values cannot rewrite an existing socket-bearing manifest.
   Assert **target provenance** (R3, R6) in three separately checkable parts.
   The wrong-run case is asserted through the API shape that makes it
   unconstructible, not through a runtime comparison the product cannot perform:
   `targetFromManifest` reading one plain object could never detect a
   same-object field swap, so an assertion phrased as "reject an A-manifest
   paired with a B-socket" would be unsatisfiable as written. The mechanism
   below replaces it.

   **5a — Constructibility bound (compile-time and runtime).** Assert
   `TmuxTarget` has no public constructor and that `targetFromManifest` has
   **exactly one parameter**, so there is no socket parameter anywhere in the
   public surface through which an independently sourced socket could be
   supplied. Assert with `@ts-expect-error` negative type tests that each of
   these fails to compile: a two-argument `targetFromManifest(handle, socketB)`;
   a target built from an object literal `{ socket, session }`; a call passing a
   plain (unbranded) manifest-shaped object. Assert at runtime that passing an
   unbranded plain object throws `TmuxTargetProvenanceError`. Assert the brand
   symbol is not exported from the production entrypoint, and that
   `ManifestHandle` is frozen and carries `runId`, manifest pathname, and the
   SHA-256 of the bytes read. Enumerate the public exports of `tmux-socket.ts`
   and assert the module-private socket-only `tmuxArgv` is **absent** from them.

   **5b — Cross-run non-contact (runtime, two real servers).** With real
   manifests for runs A and B on real servers A and B, assert that the only
   targets obtainable are A's own and B's own, and that driving every consumer
   from A's handle — while B is live and `LOOP_TMUX_SOCKET`, `TMUX`, and
   `TMUX_TMPDIR` all point at B — emits argv carrying A's socket **and** A's
   session on every invocation, and contacts server B zero times. Assert B's
   decoy session content is byte-identical before and after. This is the
   behaviour the defect is about, and it is asserted directly rather than
   inferred from a well-formed-looking argv.

   **5c — Recorded residual, asserted where it is enforceable.** A manifest
   whose *recorded* socket does not match the server its run actually lives on
   is outside the mechanism's reach: the manifest is the source of truth by
   design (R6), so no in-product check can tell a legitimately recorded socket
   from an edited one. Do not assert a rejection the product cannot perform.
   Assert instead the two properties that *are* enforceable and that bound the
   residual: hostile ambient state cannot rewrite an existing socket-bearing
   manifest (above), and a manifest whose socket is unusable yields `unknown`
   and never `dead` (verify 10). Record the residual explicitly in the eval
   notes; an unrecorded residual reads as coverage that does not exist.

   Assert `resolveTmuxSocket` is unreachable from any post-launch consumer path,
   and that a post-launch consumer has no parameter through which to supply a
   socket even if it were reachable.

6. Assert the derived migration checks report no server-contacting direct tmux
   invocation, no bare-session shared-liveness call, and no unqualified attach
   formatter across `loop-fork/src`. Prove non-vacuity against temporary seeded
   source trees, not by editing tracked source: a seeded Bun-array
   `["tmux", ...]` violation fails the checker, a seeded Node
   `spawn("tmux", [...])` violation fails it, and a seeded second direct
   invocation inside `install.ts` fails it. Each seeded case is asserted
   **independently** nonzero, not as one aggregate run. Assert the bounded
   `install.ts` `tmux -V` exception is matched by exact path **and** exact argv,
   so a different invocation in the same file still fails. Assert the check is
   wired into `scripts/verify.sh`.
   Assert the three API-shape rules from R12, each with its own seeded
   violation and each independently nonzero: a seeded import or barrel
   re-export of the module-private socket-only `tmuxArgv` outside
   `tmux-socket.ts` fails the check; a seeded argv array literal containing a
   `-S`, `-t`, `-s`, or `=`-joined target flag outside `tmux-socket.ts` fails
   it; and a seeded pane-effecting signature taking a bare `string` pane id or a
   `(TmuxTarget, paneId)` pair fails it. These three are what keep R3's
   unexported helper unexported and R10's `OwnedPaneTarget` unbypassed; without
   them both are conventions rather than boundaries.
   State the checker's analysis method explicitly. If it is regex-based, add a
   seeded **indirect** case — a helper or alias that reaches tmux without a
   literal `"tmux"` token at the call site — and record that a regex checker
   cannot claim full coverage. If it is AST/parser-based, state that and assert
   the indirect case is caught. Either way the limitation is recorded rather
   than left implied: a checker that silently misses indirection would certify a
   migration that is not complete.

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


7. Producer-backed two-server regression. Create real tmux servers A and B on
   explicit sockets, with a same-named decoy session on B. Launch the real run
   with the compiled product so it lands on A. Then run consumers with
   `LOOP_TMUX_SOCKET`, `TMUX`, and `TMUX_TMPDIR` all pointing at B, and assert
   read, capture, send, bridge, and liveness operations reach only A by using
   the manifest target. Assert decoy B session content is byte-identical before
   and after.

8. Consumer matrix with **named per-consumer assertions**. "Every consumer" is
   not certified by one shared-helper assertion. Each assertion identifies the
   invoked socket, the result, and the prohibited side effect, for:
   `tmux.ts` launch, `tmux.ts` resume, `tmux.ts` attach; `tmux-control`
   (`tmuxSessionLiveness`, `tmuxSessionLivenessAsync`); bridge capture, send,
   and buffer paths plus the `BridgeStatus` schema; `claude-config-gc`;
   `run-process-cleanup`; `launch-reservation`; `codex-tmux-proxy`;
   `paired-options`; panel enumeration; `governess-pane-liveness`; Governess
   pane effects; Governess handover; and Governess replay.
   Where a consumer skips, assert the emitted `TmuxSkipRecord` **by field**
   (`consumer`, run identity, `session`/`pane` or explicit absence,
   `socketState`, `reason`, `effectSkipped`) as read from the injected sink.
   Asserting only that "a log line appeared" does not satisfy this check, and no
   assertion may read rendered pane text to decide whether a skip occurred.

9. Destructive two-server direction. Under hostile B ambient state with the run
   live on A, assert: `claude-config-gc` does not remove the A registration;
   `run-process-cleanup` does not signal A-owned PIDs and does not mark the A
   manifest failed; launch reservation does not admit a duplicate launch;
   `codex-tmux-proxy` does not stop and emits no `reason: "dead-tmux"`; bridge
   stale-state cleanup does not clear topology; and Governess does not kill or
   respawn on B-derived evidence.

10. Legacy/invalid manifest targeting. Assert every liveness reader yields
    `"unknown"` and never `"dead"`; that launch, resume, and handover
    acceptance are blocked; that bridge delivery stays durably queued with no
    tmux command issued; that both GC paths and all tmux effects skip; that
    manifest and process state are preserved unchanged; and that a
    consumer-specific skip record is emitted. Assertions are **per consumer** —
    a skip that emits no record is a fail-open and fails this check. Each record
    is asserted by field against the injected sink, per the `TmuxSkipRecord`
    schema in R8, with `socketState` distinguishing `missing`, `invalid`,
    `conflicting`, and `unknown`. A record whose `effectSkipped` does not name
    the concrete effect that was suppressed does not satisfy this check.

11. Assert server-scoped enumeration keys by `(socket, session)`: same-named
    sessions on A and B remain distinct rows and are never merged; panel rows
    carry qualified attach commands; `run-process-cleanup` evaluates each
    manifest against its own server; and one unavailable server cannot produce
    a dead verdict for a target on another server — it is surfaced as
    partial/unknown evidence and does not erase other sockets' rows.
    Assert the three row states explicitly, so none is left to implementation
    choice: a valid socket whose session is **present** renders live with a
    qualified attach command; a valid socket whose session is **absent** renders
    `dead` and the row is **retained, never omitted** (the socket was known and
    the query succeeded, so absence is real evidence); a manifest with no usable
    socket renders `unknown` and non-attachable and is never queried. Assert
    that "legacy row" means a manifest-backed row rendered unknown, and that no
    query is ever issued against an unknown server — so valid-socket-only
    enumeration and legacy rows do not conflict.

12. Assert all attach hints and interactive attach argv include shell-safe
    `-S <socket> -t <session>`. Assert a socket path containing spaces and
    shell metacharacters round trips as data through both the argv path and the
    human hint formatter. Assert a legacy row prints an explicit unknown-socket
    line and no attach command.

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


13. Assert the `-S` versus `-L` precedence empirically and record the output:
    run `tmux -L <label> -S <path> start-server`, then assert `<path>` exists
    and the label-derived path does not. Assert every smoke call site uses an
    absolute `-S` identity: `evals/smoke/large-prompt-launch.sh`,
    `evals/smoke/active-launch-interlock.sh`,
    `evals/smoke/paste-submit-readiness.sh`, and any further call site found by
    a repository search. Assert by repository search that the old
    product-facing label shim is gone or no longer on the product's PATH.
    Assert the migrated `large-prompt-launch.sh` length assertion uses the same
    byte-based property as the producer, replacing its Darwin-only character
    count.

14. Fixture provenance. Assert new-path integration evidence comes from the
    compiled product producer and records producer binary SHA-256, tmux
    version, capture command, UTC time, relevant environment, and manifest
    SHA-256. Assert legacy fixtures are generated deterministically by removing
    only the `tmuxSocket` field from producer output and record both source and
    derived SHA-256. Assert no hand-authored fixture is used alone to certify
    this cross-process seam.

15. Assert the cleanup trap is installed **before** any server or process is
    created and runs on success, on assertion failure, and on signal. Assert it
    records both server PIDs and every run-owned launcher, pane, bridge, proxy,
    and app-server PID before teardown; kills both servers; removes both socket
    files and both temporary roots; then polls every recorded PID with a
    bounded deadline and fails if any survives.

16. Assert the zero-survivor proof is non-vacuous, in this exact order:
    (a) it fails when no server PID and no run-owned PID were recorded;
    (b) the positive control runs **before** real cleanup — with a known-live
    recorded PID, assert the detector returns **failure**, proving it can see a
    survivor at all; (c) clear the control; (d) run real cleanup; (e) assert the
    post-cleanup proof passes. Running the control after cleanup would prove
    nothing, because there would be no survivor left to detect.
    Assert the cleanup trap kills **only** PIDs it recorded as run-owned and
    never an unrelated PID, and that servers are addressed by explicit socket
    path — a bare `tmux kill-server` is never issued. Assert the post-cleanup
    proof requires no live recorded PID, no A or B socket file, no session on
    either explicit socket, and no touched host or product run path.

17. Assert existing bounded-control semantics are unchanged: timeout and error
    remain `unknown`, interactive attach alone remains unbounded, and every
    non-interactive tmux command retains a finite kill-on-timeout bound.

18. Assert `install.ts` output and symlink behavior are byte-for-byte unchanged
    outside the patch, using `tests/install.test.ts` only to prove non-change.
    Assert pre/post no-mutation evidence for product `loop-fork/runs/`: a
    read-only inventory of in-scope paths with hashes and mtimes taken before
    and after verification, compared and equal. Assert Harvto was not
    inspected, addressed, signalled, or mutated. Any mutation outside the
    isolated smoke temporary root and `runs/tmux-socket-normalization/` fails
    certification.

## Commands

Run from `loop-fork/` unless stated otherwise.

```bash
# Focused
bun test tests/loop/tmux-socket.test.ts
bun test tests/loop/run-state.test.ts
bun test tests/install.test.ts

# Repository checks
bun run check
bunx tsc --noEmit          # documented invocation, exactly as in repo docs
bun run build
env -u TMUX -u TMUX_PANE bun run test:ci

# Smokes (repository root)
bash evals/smoke/tmux-socket-normalization.sh
bash evals/smoke/large-prompt-launch.sh
bash evals/smoke/active-launch-interlock.sh
bash evals/smoke/paste-submit-readiness.sh

# Governed verify (repository root, after eval.json exists)
scripts/verify.sh tmux-socket-normalization tmux-socket-normalization
```

`env -u TMUX -u TMUX_PANE` is required, not cosmetic: `src/cli.ts:79`
`shouldAwaitAutoUpdate` is `!process.env.TMUX && ...`, so running the suite from
inside a tmux pane fails three `tests/loop.test.ts` auto-update assertions for
environmental reasons. That is a known instrument property, not a base defect.

## UI checks

**Not applicable.** Panel rows and attach hints are terminal output. There is no
DOM and `scripts/capture-ui.sh` cannot capture them. Verify 12 uses exact render
assertions plus `tmux capture-pane` evidence instead. The eval records web
screenshot and DOM as not applicable with this reason.

## Regression guards

These must not regress:

- [ ] `evals/smoke/large-prompt-launch.sh` still passes after shim migration.
- [ ] `evals/smoke/active-launch-interlock.sh` still passes.
- [ ] `evals/smoke/paste-submit-readiness.sh` still passes.
- [ ] Existing `tests/loop/tmux-control.test.ts` timeout semantics (check 17).
- [ ] `tests/install.test.ts` unchanged behavior (check 18).
- [ ] `env -u TMUX -u TMUX_PANE bun run test:ci` fully green, empty allowlist.

## Fixture provenance

- [ ] Each integration fixture derives from captured compiled-product output and
      records producer binary SHA-256 and tmux version.
- [ ] Capture command, UTC time, and relevant environment are recorded next to
      the fixture.
- [ ] Raw bytes are retained, or a durable raw reference plus SHA-256 when the
      raw capture cannot be committed safely.
- [ ] Normalization is deterministic, checked in, and records the normalized
      fixture SHA-256. No secrets or personal data enter Git.
- [ ] Legacy fixtures are derived by removing only `tmuxSocket` and record both
      source and derived SHA-256.
- [ ] No hand-authored fixture certifies the cross-process seam alone.

## Rollback conditions

Revert immediately if, after merge, any of the following is observed:

- A launch fails to resolve a socket on a host where it previously succeeded
  with no operator override set (regression in rule three).
- Any run's processes are signalled, or its Claude config removed, while its
  tmux session is live (the original defect, or a new fail-open).
- The panel stops showing a live run that has a valid socket in its manifest.
- Any smoke contacts a tmux server outside its own temporary root.
- `scripts/verify.sh tmux-socket-normalization` regresses to a non-empty
  tolerated-failure set.

## Eval output format

The evaluator writes `runs/tmux-socket-normalization/eval.json`:

```json
{
  "task_id": "tmux-socket-normalization",
  "feature": "tmux-socket-normalization",
  "timestamp": "[ISO-8601]",
  "checks": {
    "functional": { "passed": 0, "failed": 0, "details": [] },
    "ui": { "passed": 0, "failed": 0, "screenshots": [], "notes": "not applicable — terminal output, no DOM" },
    "performance": { "passed": 0, "failed": 0, "details": [] },
    "regression": { "passed": 0, "failed": 0, "details": [] }
  },
  "baseline_failures": [],
  "verdict": "pass | fail",
  "notes": ""
}
```

`baseline_failures` must be `[]`. The evaluator agent must be different from the
implementation agent.
