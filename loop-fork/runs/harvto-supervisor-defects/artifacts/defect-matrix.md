# Defect Matrix — harvto-supervisor-defects

Baseline commit: `0f69b9a99f9163bf9f83075530e26aed21258463`
Evidence (read-only, not modified): `/Users/amgad/harvto/docs/team/weeks/2026-W33.md`,
`/Users/amgad/harvto/docs/team/backlog.md`, `/Users/amgad/harvto/STATUS.md`.

Evidence survey note: the Harvto supervisor's control-plane defect reports are concentrated
in `docs/team/weeks/2026-W33.md` (shift retros and "Engineer record" blocks). `STATUS.md`
(14,369 lines) and `backlog.md` are product/program records; a keyword sweep for the
thirteen control-plane defect terms returned 1 hit total in `STATUS.md` ("unconsumed") and
0 defect-file entries in `backlog.md`. Those two files therefore contribute no additional
incidents beyond the weekly file.

Status vocabulary: `confirmed` (reproduced or invariant proven missing against this
baseline), `already-fixed`, `duplicate`, `not-reproduced`.

## Confirmed defects

### D1 — Bridge message expires or dead-letters without regard to peer liveness (P0)

- Reports: loop-173 occurrences 1-3 (decisions `cd019cb7`, `7a6669ba` late, resends
  `38be2d13`, `a06c5d36`, `185495aa` required); loop-177 occurrences 4-5; W33 S1-S3 repeated
  TTL/dead-letter recovery from `bridge.jsonl`.
- Reproduction at base `52e244b8d49258ea1768580fba2042719030d884`: named test
  `D1 live liveness callback suppresses ttl expiry and queue-depth dead-letter terminalization`
  ran both operations before assertions and failed unpatched with `Expected length: 1` /
  `Received length: 0`. Its TTL journal appended `expired`; its live queue overflow appended
  `dead-letter` with `target queue limit 1 reached`. Exact command and journal lines are in
  `runs/harvto-d1-live-peer-expiry/artifacts/baseline-reproduction.md`.
- Invariant: TTL/depth terminalization requires current peer-scoped authoritative `dead` evidence.
  Live and unknown retain. Exact manifest left/right pane mapping plus bounded pane evidence and
  configured Codex app-server PID evidence compose tri-state liveness; notification, heartbeat,
  pane prose, session-only evidence, and missing evidence cannot prove safe discard.
- Fix: `src/loop/bridge-store.ts` lazily resolves and memoizes liveness only for elapsed TTL or
  pressure, threads one cache through enqueue's transitive pending read, and preserves old
  expired/dead-letter behavior only for `dead`. One live/unknown pressure slot persists optional
  `retainedReason: "queue-pressure"`; default `maxRetained` is 33 (`maxOutstanding + 1`). At the
  retained ceiling, net-new work returns pre-accept `backpressure` with no bridge/transcript event.
  Supersession runs before the ceiling. `src/loop/tmux-control.ts` adds exact-pane tri-state probing;
  nonzero probe exits remain unknown, and only successful exact `pane_dead=1` output proves dead.
  `src/loop/bridge-dispatch.ts`, `src/loop/governess.ts`, and `appendBridgeMessage` expose or reject
  backpressure without reporting queued success. No new event kind or queue-health field exists.
- Named controls in `tests/loop/governess-p0-runtime.test.ts`: `D1 unknown liveness retains
  ttl-expired messages fail-closed`, `D1 live pressure slot reaches a pre-accept retained ceiling`,
  `D1 later-dead evidence terminalizes retained ttl and pressure once`, `D1 same-dedupe
  supersession remains accepted at retained ceiling`, `D1 repeated recovery reads and consumes
  deliver one retained identity once`, `D1 old and fixed message shapes reconstruct compatibly`,
  and `D1 target liveness combines exact configured evidence fail-closed`. Pane/server controls are
  in `tests/loop/tmux-control.test.ts`; formatter/wrapper control is `dispatchBridgeMessage reports
  backpressure distinct from queued` in `tests/loop/bridge.test.ts`.
- No-duplicate proof: three reconstructed pending reads, then two consumes, produce one effective
  delivery and exactly one `delivered` resolution. Repeated later-dead reads append exactly one
  `expired` or `dead-letter` for each retained identity.
- Verification: D1 file 16 pass / 0 fail; bridge file 109 pass / 0 fail; tmux file 6 pass / 0 fail;
  `bun run check`, canonical `bunx tsc --noEmit ...`, and `bun run build` pass; all 77 serial
  `bun run test:ci` files pass. Repo-root eval verdict is `pass` with empty `baseline_failures`.
- Review: design clearance bridge `1c929e52-f05e-4528-8beb-a2320bd14e48`; initial commit
  `bcabd31b551f3adbf5dbeccd39439a6a84edfe1d` and request
  `ba1ee254-7043-4291-b179-fb2140a50d31` were superseded after both reviewers identified the
  nonzero-probe ambiguity. Replacement commit `2986c38c4499cdd27162801880d5e4aef0f173c0`
  received zero-write Claude `PASS` via response bridge
  `c0c49af4-e3ed-4f7d-ada2-7fc562e28e23` to request
  `6e16287c-28d3-494e-9026-be1bf8df0a3e`.
- Status: **confirmed, fixed, verified, and exact-SHA reviewed PASS**.

### D2 — Lying liveness: workspace ownership derived from recorded state prose, not process evidence (P0)

- Reports: W33 S3 2026-08-10 "clearing 94 dead legacy-manifest launch ghosts (archived,
  defect evidence filed) + a lying-liveness crashed-start manifest"; W33 S1 "first-start launch
  race recurred twice (failed-start manifests archived, probe-boot + retry recipe now routine)";
  W33 S3 "tmux session died in the server-death race (second occurrence) ... Run-198 manifest
  still owns the workspace (archive before relaunch)".
- Code: `src/loop/launch-reservation.ts:94-105` (`manifestCanStillOwnWorkspace`).
- Mechanism: when the manifest-recorded tmux target is dead, the function falls back to
  `return isActiveRunState(manifest.state)`. `isActiveRunState`
  (`src/loop/run-state.ts:599-600`) is a pure set-membership test on the recorded state
  string — a claim written into the manifest, not positive process evidence. A crashed start
  that never cleared its state, and a legacy manifest with an active-looking state, both
  report "still owns the workspace" forever. The sibling path
  `reserveRequestedLaunch` (`launch-reservation.ts:211-215`) already demonstrates the correct
  standard by requiring `deps.isPidAlive(pid)`.
- Violated acceptance principle: "Liveness must be derived from the exact manifest-recorded
  tmux target and positive process/pane evidence."
- Regression tests (`tests/loop/launch-reservation.test.ts`), 3 defect cases:
  `crashed start with a dead tmux target and no live pid cannot own the workspace`,
  `legacy manifest ghost without a tmux target cannot own the workspace`,
  `ghost manifest no longer blocks a fresh launch on its workspace`.
  4 controls proving the predicate was not merely inverted:
  `dead tmux target with a live run pid still owns the workspace`,
  `dead tmux target with a live launch attempt pid still owns the workspace`,
  `live tmux target owns the workspace without any pid evidence`,
  `unknown tmux liveness owns the workspace rather than failing open`.
- Baseline proof: against unpatched `src/`, the file ran 15 pass / 3 fail, the 3 failures
  being exactly the 3 defect cases with all 4 controls green. The end-to-end case surfaced
  the supervisor-reported string verbatim: `[loop] launch conflict: run 1 (ghost-session)
  still owns workspace ... resume or stop that run before launching another`.
  After the fix: 18 pass / 0 fail.
- Fix: `src/loop/launch-reservation.ts` — extracted `liveManifestPid(manifest, deps)`
  (first of `launchAttemptPid`, then `pid` when `isActiveRunState`, that satisfies
  `deps.isPidAlive`) and made `manifestCanStillOwnWorkspace` return
  `liveManifestPid(...) !== undefined` on a dead tmux target. The predicate is not new
  policy: it was lifted from the sibling path `reserveRequestedLaunch`, which already
  required `isPidAlive`; both now call the one helper. Live and unknown tmux are unchanged,
  so unknown still fails closed.
- Three pre-existing tests were updated, assertions untouched: their fixtures used
  `pid: 999` while `reservationDeps` reports only 4242 alive, with a dead tmux target and no
  `launchAttemptPid` — i.e. the fixtures were themselves ghosts. Their names all say
  "active", and under the corrected invariant active must mean process-alive, so the
  fixtures now carry real liveness. The terminal-state case was deliberately left at
  `pid: 999` so it keeps proving that terminal ownership is permitted. Peer confirmation of
  this reading was requested from Codex and CONFIRMED (bridge `5d8c827d-7d43-4aff-92cf-d844d726cb19`):
  "They previously asserted conflicts using dead tmux + dead pid + active state, which is
  exactly D2 lying-liveness. Changing only liveness inputs preserves assertions and intended
  branch meaning." Codex also rejected the counter-reading that D2 belongs at the archival/GC
  layer: "GC can reduce ghosts but cannot make reservation race-safe; ownership predicate
  must validate evidence at decision time."
- Peer verdict: **PASS**, zero-write, at exact SHA `267c14b3059e87bcc34e81179e1c31c7b01135ca`
  against base `0f69b9a99f9163bf9f83075530e26aed21258463`
  (bridge `00c767cd-b065-456e-83a7-9bbe92cdfbb3`). Codex independently re-derived the suite
  numbers rather than accepting mine: 77 Bun file banners, 1544 summed pass, no failing file.
  Codex also independently confirmed blast radius: production use is only `assertNoConflict`
  and `reserveRequestedLaunch` via the shared helper.
- Status: **fixed, peer-PASSED**.

### D3 — `route_task` admits work with no router or eligible tier and stays `pending-route` forever (P1)

- Reports: W33 S2 "route_task accepted work with no worker tier available (pending-route
  forever — defect flavor for the engineer)"; supporting utility-outage context — ruling
  `1b63c048-22d0-4ecf-aabe-e13ae990ef31` after audits `9b476b89-e377-4146-a5f3-666db83f1664`,
  `ba8f2bcd-f926-4158-80ec-416fc67a73ab`, `1684ca9a-0f9e-46f3-8727-51e1cdda1851` each failed
  HTTP 402; ruling `sup-191-402-route`.
- Code: `src/loop/bridge-utility.ts:1054-1082` (`routeTask` admission and response),
  `src/loop/utility-store.ts:508-529` (`appendUtilityRouteRequest`),
  `src/loop/governess.ts:7259-7288` (the only caller of `processPendingUtilityRoutes`).
- Mechanism: `routeTask` validates boundedness, appends the job at `state: "pending-route"`,
  and returns that state. Nothing in the admission path checks that a router exists or that
  any tier could ever claim the job, and no deadline is recorded. Draining depends entirely on
  `governess.ts:7259`, `if (config.runDir && config.cwd && holder && utilityPeer)`, which has
  no `else` branch: when there is no lease holder or no peer, pending jobs are skipped
  silently, with no log line and no failure.
- First-party live reproduction in this run (run id `50`,
  `/Users/amgad/.loop/runs/agents-collab-fa87e8608224/50`): three packets submitted at
  16:46-16:47Z — `7384a3b8-9ffd-4be9-8c58-7efb64bc9207`,
  `74af8699-fd10-443e-9d1a-722b1b580aa6`, `0d4e4c2d-e93a-4f8b-9f3e-1cb6047d917c` — all
  accepted and all still `pending-route`. `utility/jobs.jsonl` holds exactly three
  `route-requested` events and zero `route-decided` events; the run directory carries no
  Governess routing log. `bridge_status` at the same time reported the bridge healthy
  (`status: running`, `tmuxLiveness: live`, `deadLetters: 0`, `pending: 0`), so absence of
  routing capacity presented as a healthy system.
  Independent second-party reproduction from the paired peer in the same run: Codex reported
  its own utility-audit routes `6ac1984b-b1d5-4083-9497-f781c09b1630` and
  `d32fd58c-807f-4961-ae7c-851bd588a7e3` also stuck at `pending-route`. Two agents on
  separate lanes, five packets total, zero routed — the symptom is not specific to one
  requester.
- Violated required outcome: "Make absence of delivery, routing capacity, liveness, or
  completion evidence fail closed rather than appear healthy"; and the acceptance principle
  "Routing must reject or durably fail a job when no eligible worker exists; it may not
  remain pending forever."
- Note: `routeUtilityRequest` (`src/loop/task-router.ts:1080-1094`) does correctly fail over
  to the driver with reason `utility-unavailable` when no tier is eligible. That logic is
  sound; the defect is that it is never reached when no drain occurs.
- Regression: `D3 Governess fails closed once when pending utility work has no routing peer` in
  `tests/loop/governess.test.ts`.
- Exact-base reproduction: at `d5d3140844f9ff7f8447156f4b4f7f27ac093d96`, two bounded
  Governess cycles with one current driver and no peer left exactly one
  `route-requested:pending-route` event, `decision: undefined`, and no terminal state. The named
  regression returned 0 pass / 1 fail. Evidence:
  `runs/harvto-d3-pending-route/artifacts/baseline-reproduction.md`.
- Status: **confirmed, reproduced red**.

### D4 — Routed peer message remains unconsumed while the exact peer is live (P0)

- Report: W33 S3 2026-08-10, "reviewer sat jammed on a new delivery-defect flavor (queue
  routed-peer, unconsumed while live)."
- Base reproduction: unchanged production SHA `0822c3546c44521ea778324d66d6c4c98f3972fb` entered
  durable utility state `routed-peer`, appended the exact Codex-to-Claude `review_request`, proved
  Claude's exact pane positively live, recorded exact peer consumption, and appended a correlated
  Claude-to-Codex decision. One further reconciliation still left `state=routed-peer` and
  `result=undefined`. The named regression failed 1 with 52 existing controls passing.
- Mechanism: `processPendingUtilityRoutes` routed a peer review but only claimable helper jobs had a
  recovery owner. No path rediscovered a durable routed-peer request, repaired the
  transition-before-dispatch crash window, or correlated a consumed peer response into a terminal
  utility result.
- Fix: `src/loop/utility-runtime.ts` now reconciles durable routed-peer jobs with a stable
  `utility-peer-route:<jobId>` bridge dedupe key. It requires original-request delivery, correlates
  exact reverse source/target and task ID (plus `replyTo` when present), completes once only from an
  explicit `decision`; the producer request requires that exact verdict type. It fails once from
  existing durable bridge terminal evidence. `ack`, generic or legacy-untyped messages, live
  liveness, and unknown liveness remain non-terminal under bridge-owned D1 policy.
- Regressions: `D4 peer instruction requires decision while ack and untyped replies stay
  nonterminal across replay`; `D4 routed-peer reconciliation recovers the dispatch crash window
  without duplicate requests`; `D4 unknown peer remains recoverable and durable dead-letter fails
  once across replay`.
- Verification: utility-runtime 55 pass, bridge 109 pass, D1 liveness 16 pass, utility-store 15
  pass; check, canonical typecheck, build, and all 77 serial test files pass. No UI changed.
- Evidence: `runs/harvto-d4-live-peer-unconsumed/artifacts/baseline-reproduction.md` and
  `runs/harvto-d4-live-peer-unconsumed/artifacts/fix-verification.md`.
- Status: **fixed and exact-SHA reviewed** at
  `b77cf81d7ffb2e9178e4a72030335fae764090df`; Claude zero-write `PASS` bridge decision
  `c059a661-7e85-458b-ade9-338b3cca568c`.

## Drained open backlog

Reproduction and code tracing not yet complete for these; they are recorded here so the
matrix stays a complete census of the evidence rather than a list of the convenient items.
Each row also has a parked Harness idea with the same defect id. "Open" means durable and
unresolved, not omitted from intake.

| Id | Report | Priority | Source |
|---|---|---|---|
| D5 | Silent completion x2 — runs 192/193 finished with no supervisor close signal, collected only on direct worktree verification | P1 | W33 S2 |
| D6 | Read-only tmux attach blocks targeted recovery delivery; stale read-only viewer wedged run-186 delivery ~2h | P2 | W33 S1, W33 S3 2026-08-10 |
| D7 | Uncommanded Codex handoff switched model/effort `sol-high -> luna-low` (run 191, post-verdict) | P2 | W33 S2 |
| D8 | Stale utility edit lease `d161e3d6` ruled dead yet routed a two-file write (ruling `sup-187-util-dead`) | P2 | loop-173 engineer record |
| D9 | Duplicate bridge emission x4 of one RESOLVED ack (run 197) | P2 | W33 S3 |
| D10 | Guarded apply for patch `e7695c7b...5314` reported `Patch no longer applies cleanly` against an absent target | P2 | loop-173 engineer record |
| D11 | Two stuck composer nudges (run-190, both panes) | P2 | W33 S2 |
| D12 | Beat/courier discovery globs blind to the harvto tmux socket ("no live runs" blindness) | P2 | W33 S3 2026-08-10 |
| D15 | Completed teardown leaves exact manifest-owned launcher or Claude child processes alive | P0 | Supervisor campaign continuation directive, 2026-08-13 |
| D16 | Scope audit can return clean while omitting Git-derived modified paths | P0 | Supervisor campaign continuation directive, 2026-08-13 |

### D15 — Teardown reports completion while owned processes remain alive (P0)

- Source statement: the supervisor directed this campaign to cover teardown orphan processes and
  required positive liveness checks for exact manifest-owned launcher and Claude-child PIDs.
- Invariant: lifecycle cannot become stopped/completed until exact manifest-owned tmux, launcher,
  Claude child, bridge, and app-server processes are directly proven gone, or durable unresolved
  cleanup is recorded. Isolated fixtures may signal only PIDs they own and record.
- Harness intake: parked independently as `harvto-d15-teardown-process-orphans` while D3 remains
  active.
- Status: **confirmed**; reproduction and implementation remain isolated to D15.

### D16 — Scope audit false negatives omit modified paths (P0)

- Source statement: the supervisor identified scope-audit false negatives as a campaign-integrity
  defect because clean routed verdicts omitted known Git-derived modified paths.
- Invariant: scope evidence must enumerate added, deleted, renamed/copied, staged,
  committed-range, and tracked-but-routing-ignored paths. Any count/hash mismatch at the consumer
  fails closed; a genuinely clean scope still returns clean.
- Harness intake: parked independently as `harvto-d16-scope-audit-completeness` while D3 remains
  active.
- Status: **confirmed**; reproduction and implementation remain isolated to D16.

### D13 — Suite result depends on inherited `TMUX`, so agents cannot trust their own proof (found in this campaign, fixed)

- Not a Harvto-reported item. Found while establishing the baseline failure set for D2, and
  in scope because it decides whether any campaign proof command can be believed: a loop
  agent runs inside a tmux pane, which is exactly the condition that made the suite lie.
- Code: `src/cli.ts:79-80`,
  `shouldAwaitAutoUpdate = !process.env.TMUX && isPromptlessPairedTmuxLaunch(opts)`.
- Mechanism: `tests/loop.test.ts` inherited `process.env.TMUX` from the surrounding pane
  (`/tmp/tmux-501/default,2588,2`), silently routing three "started outside tmux" tests down
  the in-tmux branch. `tests/loop.test.ts` sorts first and `bun run test:ci` exits on the
  first failing file, so this presented as an entirely red mandatory suite while the
  untouched baseline was in fact green: `env -u TMUX bun run test:file -- tests/loop.test.ts`
  gave 41 pass / 0 fail with no source change.
- Latent second fault fixed at the same time: three tests restored with
  `process.env.TMUX = originalTmux`, which coerces `undefined` to the truthy string
  `"undefined"`. Inside tmux this was masked by a real inherited value; outside tmux — that
  is, ordinary CI, and also after the leak fix — it would have poisoned every later test in
  the file. Fixing the leak alone would have relocated the failure rather than removed it.
- Fix: `tests/loop.test.ts` only, no production change. Added
  `setTmuxEnv(value: string | undefined)` that deletes the key rather than assigning
  `undefined`, added file-level `beforeAll`/`afterAll` neutralization restoring the inherited
  value, and routed all three existing restore sites through it.
- Proof (the invariant is environment-independence, so all three conditions were checked):
  inside tmux 41 pass / 0 fail; `env -u TMUX` 41 pass / 0 fail; `TMUX=/tmp/fake,1,0`
  41 pass / 0 fail.
- Status: **fixed**.

### D14 — Safe composer blocks durable handover, preventing successor launch (found live in run 50, fixed)

- Not a Harvto-reported item. Found while tearing down the campaign loop after the founder
  requested the defect work continue without another routine authorization pause.
- Live evidence: run 50 reached `phase: "handoff"` for both peers, but
  `exitControl.notified` and `handoverBundles` contained only Codex. Claude remained live and
  undrained, so `allHandoverAgentsExited` could never become true and the manifest-backed
  successor launch gate could never run.
- Code: `src/loop/governess.ts`, `notifyHandoverAgents` called `directInputIsSafe` before the
  runtime adapter. That predicate combines a completed-turn hook boundary with an empty/dim
  composer requirement. The composer requirement is necessary for tmux injection, but it
  incorrectly blocked the durable bridge path too.
- Fix: split completed-turn safety from composer safety. Handover still fails closed unless
  the last non-transparent hook is a real `Stop`. When a run-scoped bridge source exists,
  an unsafe composer no longer blocks the runtime adapter; the adapter uses the durable
  bridge and independently preserves the composer guard before any tmux fallback.
- Regressions: `handover uses the durable bridge without typing over a composer draft` and
  `handover revalidates the completed turn after pane capture` in
  `tests/loop/governess-exit.test.ts`; `Codex tmux notification preserves a non-empty user
  draft` and `Codex tmux notification preserves a leading-newline multiline draft` in
  `tests/loop/bridge.test.ts`. Focused results: 30 pass / 0 fail and 108 pass / 0 fail
  respectively.
- First exact-SHA review at `67424a9da46153017c745d91c2171b3a47df04ac` returned REVISE:
  the Codex bridge notifier did not require an empty composer, and two hook reads could race.
  The correction now samples styled pane state before one final hook read, distinguishes
  unsafe-turn from unsafe-composer, requires an empty styled Codex composer in the production
  tmux notifier, and carries bounded readiness attempts through both notifier checks.
- Second exact-SHA review at `aae7c14329962ddbbcaea1a021dbed384df6d0ca` returned REVISE
  because the empty-composer predicate covered only the first visual line. The correction
  now classifies the entire current composer region up to the Codex footer, including a
  leading-newline Ctrl+J draft, before either immediate or worker notification can paste.
- Third exact-SHA review at `bf7d10b2f5bc5e4f4776019852993ff4e0ad7df4` returned REVISE
  because footer substrings could also occur in draft text. The parser now selects the last
  structurally anchored footer line ending in a workspace path; earlier deceptive ` · ` and
  `Ctrl+J newline` text remains inside the composer region and fails closed.
- Mandatory gates after correction: lint PASS, build PASS, and 77 certified test files with
  1547 pass / 0 fail.
- Final peer verdict: **PASS**, zero-write, at exact SHA
  `aa32e7a7c05ed0525a16204b2f5e908e25a278d1`. The reviewer independently reran the
  Governess suite (30 pass / 0 fail / 159 assertions), bridge suite (108 pass / 0 fail /
  468 assertions), static check, and reconciled the 77-file mandatory evidence.
- Status: **fixed, peer-PASSED**.
- Status: **fixed, exact-SHA review pending**.

## Drain receipt

The complete import cursor, source hashes, incident-to-backlog mapping, and exclusions are
recorded in `runs/harvto-supervisor-defects/artifacts/harvto-supervisor-drain.md`. At those
exact source hashes, no Harvto supervisor control-plane incident remains outside D1-D12.

## Full-suite baseline comparison

`bun run test:ci` is `for file in $(find tests -name '*.test.ts' | sort); do bun test "$file"
|| exit 1; done` — it aborts on the first failing file, so any comparison run through it
covers only the files before the first failure. All 77 test files were therefore run
individually with no early exit, on both sides:

| Run | Pass | Fail | Failing files |
|---|---|---|---|
| Baseline (both changed files reverted via `git checkout`) | 1532 | 3 | `tests/loop.test.ts` only |
| Patched (D2) | 1539 | 3 | `tests/loop.test.ts` only |

Failure sets were diffed by test NAME, not by count, and are identical. The delta is exactly
the 7 tests added for D2, with no regression anywhere in the suite. Both runs predate the D13
isolation fix, which is why the 3 TMUX-artifact failures appear on both sides.

Recorded failed path: the first comparison summed the per-file "N pass" lines and reported
49 pass / 3 fail for *both* runs, which read as reassuring. It was not — the early exit meant
only 3 files (52 tests) had run in either case, so that comparison could not have detected a
regression past the third file. It was caught because the totals did not move after adding 7
passing tests.

## Explicitly out of scope

- Driver protocol defect 6 (review request `c8aa9e90-cf9e-447b-ae1f-ba618ff15675` set a
  two-minute TTL against the launch charter's no-TTL law): this is an agent protocol error,
  not a `loop` code defect. The evidence itself records no evidence loss
  (read before expiry in `f13ba280-7d5d-4b69-badb-df839dbd80f5`). **not-reproduced** as a
  code defect. It is nonetheless a motivating case for D1: correct behavior should not
  depend on every sender remembering the no-TTL law.
- Utility-tier HTTP 402 credit exhaustion (`9b476b89`, `ba8f2bcd`, `1684ca9a`): an external
  provider-credit condition, not a repository defect. Its *handling* is in scope only through
  D3.
- All Harvto product findings (conform, aperture, drape, screen, fit) — out of campaign scope
  per `specs/harvto-supervisor-defects/spec.md` boundaries.
