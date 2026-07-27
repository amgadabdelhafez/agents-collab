# Pi SDK utility harness run log

- 2026-07-27: Created isolated worktree and architecture/specification slice
  from `codex/compound-worktree-observability` at `a2c612a`.
- 2026-07-27: Selected the official MIT-licensed
  `@earendil-works/pi-coding-agent` package; package compatibility and exact
  pinned version remain verification gates.
- 2026-07-27: Pinned the Pi SDK packages at `0.82.1`, introduced one shared
  ephemeral Pi runtime, and disabled Pi built-ins in favor of the existing
  allowlisted repository broker tools.
- 2026-07-27: Split lower-cost execution into Direct (no model), Nanny (local
  Qwen, one slot), and Au Pair (OpenRouter GLM, four slots). Each model tier has
  independent configuration and capacity with no cross-tier spillover.
- 2026-07-27: Added the governed tmux layout with Governess at four fifths and
  a right-hand fifth split into filtered Nanny and Au Pair panes. Preserved
  Loop 55 without pane or process mutation.
- 2026-07-27: Production local governess completions now use Pi no-tools
  sessions. Utility work uses broker-only Pi tool sessions; exact reads and
  checks bypass models entirely.
- 2026-07-27: Focused routing, runtime, Governess, pane, lifecycle, security,
  observability, and registered-worktree suite passed: 217 tests, 0 failures.
- 2026-07-27: Bridge compatibility suite passed: 75 tests, 0 failures. Full
  serial suite passed 1,059 of 1,065 tests. One task-related legacy-fixture gap
  was corrected by explicitly selecting the supported rollback harness and its
  12-test workspace suite then passed. Of the remaining failures, one tmux
  reconnect timing failure passed immediately in isolation; the other four are
  unchanged Codex environment/config expectations in unmodified
  `paired-options.test.ts` and `runner.test.ts` (`gpt-5.5` versus the active
  `gpt-5.6-sol`, plus injected reasoning/service-tier values).
- 2026-07-27: Narrow Ultracite check passed for all new Pi and tier files;
  `git diff --check` passed; compiled build succeeded with 3,030 modules and
  reports `loop v1.0.32`.
- 2026-07-27: Compiled-binary canary passed with two fake-provider calls,
  terminal state `completed`, Pi `0.82.1`, and summary
  `Compiled Nanny found src/sample.ts.`
- 2026-07-27: Live local-Qwen no-tools completion returned `PI_NANNY_OK`; a
  harmless brokered tool canary exposed only its single allowlisted tool and
  completed in one tool call. Loop 55 retained pane IDs `%0` through `%3`,
  PIDs 2246, 2248, 2608, and 2610, and local Qwen PID 1276.
- 2026-07-27: Root `scripts/verify.sh` completed and documented that its lint,
  typecheck, unit, and integration command blocks are still repository stubs;
  the concrete commands and results above provide this slice's acceptance
  evidence.
- 2026-07-27: Initial independent evaluation found three blockers: canceled Pi
  sessions could reach a broker call, a capacity-blocked Nanny job had no
  durable tier decision and appeared under Au Pair, and failed Pi usage omitted
  provider/version fields. Added active-state checks before every broker call,
  a 25 ms Pi cancellation monitor, pending-route tier-decision events, and
  complete failure usage evidence. Regression tests cover all three.
- 2026-07-27: A full test run left 19 temporary `__bridge-mcp` children
  reparented to PID 1, each busy-spinning and consuming roughly 50-135% CPU.
  Terminated exactly those 19 PIDs; none was a Loop 55 pane or process. Added a
  bridge-parent watchdog, explicit signal exit, and removed forced stdin resume.
  The full bridge suite then passed 76 tests and left zero bridge processes.
- 2026-07-27: Expanded focused acceptance passed 232 tests with zero failures;
  the compiled Nanny canary still passed at Pi `0.82.1`.
- 2026-07-27: During reevaluation the `harvto-loop-55` tmux server and prior
  PIDs 2246, 2248, 2608, and 2610 disappeared. They were present immediately
  before the runaway cleanup and were not among the terminated PIDs. Persisted
  manifest still says running, with no terminal Governess event. Independent
  evaluator therefore keeps the overall verdict blocked on live-state
  disposition even though its code/test reevaluation is green (utility/Pi/store
  64/64; bridge 76/76; zero branch-local bridge orphans).
- 2026-07-27: User confirmed Loop 55 was intentionally done. Independent final
  verdict is PASS with no blocking findings: utility/Pi/store 64/64, bridge
  76/76, zero orphan branch-local bridge processes, and clean diff check.
- 2026-07-27: Rebuilt the final 3,030-module binary and installed it globally.
  `/Users/amgad/.local/bin/loop` now targets this worktree binary, reports
  `loop v1.0.32`, and has matching SHA-256
  `6ede4dbabd022b5d23fc49d8ec54c74bc0f3453f7897369eea17862910f0558f`.
