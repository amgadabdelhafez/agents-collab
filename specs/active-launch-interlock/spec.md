# Active paired-launch interlock

## Problem

Harvto Loop-68 was launched twice from the same founder authorization. Runs 106
and 107 were created 24 seconds apart, and both driver/reviewer pairs wrote the
same `/private/tmp/harvto-loop68-base` worktree on `loop68/base`. The launcher
had no structured workspace binding and no repository-scoped single-flight
reservation. Each process therefore allocated a different run id and created a
different tmux session even though the work target was identical.

The current launch path also has two adjacent races:

- numeric run ids are selected by scanning for `max + 1`, so simultaneous
  launches can reserve the same run directory; and
- failed-start cleanup may kill a same-named tmux session without proving that
  the current invocation created it.

## Goal

A fresh paired tmux launch must reserve one canonical workspace/ref identity
before task resolution or agent startup, and a conflicting launcher must exit
nonzero without creating or destroying any run resources.

## Required behavior

1. `--workspace <path>` selects an existing registered Git worktree, changes
   the launch/pane working directory to its canonical top-level path, and binds
   the run to that path plus its full symbolic branch ref. Without the flag,
   the current working directory is canonicalized as the launch workspace.
2. Relative Markdown prompt paths are resolved against the invocation directory
   before entering an explicit workspace.
3. A short repository-scoped atomic lock protects conflict scanning and run-dir
   allocation. The selected run directory is created exclusively, never by a
   `max + 1` decision followed by recursive creation. Stale-lock recovery is
   serialized so a delayed reclaimer cannot unlink a replacement owner. Run
   history and tmux-liveness scans yield to the event loop so the lock heartbeat
   remains renewable even when the critical section exceeds its stale window.
4. The reservation is a durable submitted manifest written before
   `resolveTask`. It persists immutable workspace root, branch ref when one
   exists, run-level launch claim id, and source charter SHA-256 once resolved.
   A separate attempt id/pid identifies the one process allowed to bootstrap.
5. A fresh launch conflicts when an existing non-dead workspace has the same
   canonical root or the same symbolic branch ref. An active legacy manifest
   without a structured binding blocks fresh launches fail-closed because
   distinctness cannot be proved.
6. A live tmux session blocks even if its manifest is already terminal during
   teardown. Unknown tmux liveness blocks without mutation. A terminal manifest
   with affirmatively dead topology does not block.
7. An explicit resume of the same run reuses its durable identity and attaches;
   it does not create a competing reservation. A cold resume receives a
   replaceable bootstrap-attempt claim after the old owner is dead, and only
   one live attempt can proceed. A live resume attaches without creating a new
   attempt. Resumes must match the immutable source-charter SHA-256.
8. Duplicate rejection happens before planning agents, bridge registration,
   hooks, persistent Claude/Codex transports, charter files, proxy processes,
   or tmux panes.
9. Manifest replacement is atomic. Readers must see either the old complete
   manifest or the new complete manifest, never a partial overwrite.
10. Failed-start cleanup may kill a tmux session only after this invocation's
    `new-session` command positively succeeded. A racing loser cannot kill or
    terminalize the winner.
11. Conflict errors name the existing run id, tmux session when known,
    workspace root, and branch ref, and the CLI exits nonzero.

## Acceptance criteria

- Two barrier-synchronized fresh launches for the same workspace/ref produce
  exactly one durable reservation and one workspace winner.
- The loser performs zero planning-agent, transport, hook, charter, proxy,
  `new-session`, or `kill-session` work.
- Distinct worktrees on distinct branches serialize through the short lock and
  both remain launchable.
- Same root/different ref and different root/same symbolic ref both conflict.
- Live, dead, unknown, terminal, legacy, and explicit-resume cases follow the
  required behavior above.
- Two barrier-synchronized cold resumes preserve the run-level claim and source
  hash while producing exactly one bootstrap-attempt winner.
- Active manifests in every valid run-id directory, including alphanumeric
  ids, participate in conflict scanning.
- A deliberately delayed reservation scan that exceeds the stale window still
  produces one owner; no contender may reclaim a healthy lock heartbeat.
- Run-manifest round-trip tests cover the new immutable fields and legacy
  compatibility.
- A compiled isolated smoke launches once, rejects an identical second launch
  nonzero, and proves exactly one live session and active manifest.
- Focused tests, full `bun run test:ci`, `bun run check`, build, root
  `scripts/verify.sh`, Harness gates, and independent exact-SHA review pass
  before deployment.
- Deployment, if performed, is atomic and announced with commit plus SHA-256.

## Non-goals

- Parsing free-form charter prose as authoritative workspace identity.
- Restarting, mutating, or using live Harvto run 106 as a test fixture.
- Changing routing, helper permissions, models, pane layout, or Governess
  policy.
