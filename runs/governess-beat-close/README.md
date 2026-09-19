# governess-beat workflow closes with the run

Implementation commit `7b5ccdbf` on `claude/governess-beat-close` (from
`ec185ba1`).

## Mechanism

Terminate, not a completion signal. `temporalWorkflow` returns `Promise<never>`
and production runs no worker on `loop-governess` (the journal writes through
`signalWithStart` so it needs none). A signal would be buffered and never
processed. Terminate closes the execution server-side and keeps its history, so
the journal can still be read back.

## Terminal paths

| Path | Who marks it terminal | How the workflow closes |
|---|---|---|
| Operator teardown key, panel teardown intake, handover to a replacement | governess `stopGovernessLoop` (`markRunStopped`) | inline: flush and detach the sink, terminate, then kill the session (15 s bound; a failed close still kills) |
| Paired tmux start failure | launcher `terminalizeFailedStart` -> failed | inline in the launcher once the manifest is durably failed |
| `loop reconcile stopped-run <id>` | CLI | inline once reconciliation succeeds |
| Abandoned run (pane or tmux died) | startup `gcAbandonedRunProcesses` -> failed | startup reconcile, which runs right after GC |
| codex-tmux-proxy dead tmux -> stopped; `paired-loop` `finishRun`; launch reservation release -> failed | those processes | startup reconcile |

## Live-run safety

- The close refuses unless the run's own manifest is terminal
  (`refused-live`), checked before anything is described.
- Reconcile also skips a terminal run whose tmux session is alive, or every
  tmux-owned run when tmux cannot be listed (the governess may still be
  flushing).
- Run ids are per-repo integers, so two repos can share `governess-beat:<n>`.
  The journal now writes memo `loopRepoId` when it creates the workflow. A
  foreign memo is always refused. A missing memo is refused except by the run's
  own governess, which may have inherited a workflow an older binary created.
  Consequence: workflows created before this change (for example
  `governess-beat:29`) are never closed by reconcile. Those are the
  supervisor's to close.
- The governess detaches its journal sink before terminating, so a later
  record cannot `signalWithStart` a fresh, never-closed execution.

## Proofs

1. Unit tests: `loop-fork/tests/loop/governess-beat-close.test.ts` (24 tests,
   real Temporal test server for describe/terminate), plus
   `tests/loop/tmux.test.ts` (failed start closes; preserved live session does
   not) and `tests/loop.test.ts` (reconcile runs after abandoned-run GC).
2. Live proof: `live-proof.ts`, output in `live-proof.log`. Server
   `192.168.1.18:7233`, namespace `harness`, independent readback through the
   Temporal UI HTTP API on `:8233`.
   - `governess-beat:beatclose-proof-1789800483781-abandoned`: started RUNNING
     (3 events); reconcile while the run was `working` left it RUNNING; the real
     abandoned-run GC marked the run `failed`; the real startup reconcile
     terminated it: `WORKFLOW_EXECUTION_STATUS_TERMINATED`, 4 events, close
     time `2026-09-19T06:48:04.148755034Z`. A second reconcile reported
     `already-closed`.
   - `governess-beat:beatclose-proof-1789800483781-teardown`: started RUNNING;
     the real `stopGovernessLoop` with the real default close marked the run
     `stopped`, terminated the workflow, then killed the (stub) session:
     `WORKFLOW_EXECUTION_STATUS_TERMINATED`, 6 events, close time
     `2026-09-19T06:48:04.515227231Z`.
   - `governess-beat:29` read back unchanged afterwards: RUNNING, 19 events.
   - `loop reconcile stopped-run` (session 2): `live-proof-stopped-run.ts`,
     output in `live-proof-stopped-run.log`. The real CLI as a subprocess under
     a throwaway HOME, run id `91789801147007` (far above any real run number; rerun on the
     final code, an earlier run `91789800898334` gave the same result).
     `governess-beat:91789801147007` started RUNNING (3 events); the CLI while
     the run was `working` refused (`run-is-not-stopped`) and left it RUNNING;
     after the run stopped, the CLI reconciled and closed it:
     `WORKFLOW_EXECUTION_STATUS_TERMINATED`, 4 events, close time
     `2026-09-19T06:59:07.614906703Z`; a second CLI call reported
     `already-closed (TERMINATED)`.
3. Mutations: `mutation.log`. Skipping the close on the governess teardown
   (2 tests fail), on the tmux failed start (1 fails), skipping the startup
   reconcile (1 fails, plus the allowlisted one), and dropping the live-run
   guard (6 fail). All sources restored. Session 2 added mutation 5:
   skipping the close in `loop reconcile stopped-run` fails `runCli reconciles
   one synthetic stopped run before startup maintenance`. Mutation 6 (drop
   the per-RPC deadline) fails `deadline: the connected control bounds describe
   and terminate on a real server`, and three later tests in that block time
   out as a cascade.
4. Session 2 review fix: an independent review found that only the dial was
   bounded (3 s), so a server that accepted the connection and then hung would
   stall every CLI startup in the reconcile. `describe`/`terminate` now run
   under `connection.withDeadline` (5 s each).
   Session 2 (after routing the stopped-run close through `cliDeps` and adding
   its CLI tests): `bun run check` clean (941 files); `suite.log` is the full
   suite, 123 files one by one under `env -u TMUX -u TMUX_PANE
   LOOP_TEST_CERTIFICATION_MODE=single-file`: the only nonzero file is
   `tests/loop.test.ts`, the only failure by name is the allowlisted `runCli
   awaits auto-update before handing off promptless paired tmux startup`.
   Touched files: `governess-beat-close.test.ts` 25/0, `tmux.test.ts` 115/0,
   `loop.test.ts` 44/1 (the allowlisted one).
5. `git diff --numstat` equals `--ignore-all-space` for every commit on the
   branch (see status.md).
