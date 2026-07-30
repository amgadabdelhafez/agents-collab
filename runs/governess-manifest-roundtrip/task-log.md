# Governess manifest round-trip task log

## Filed defect

- Run 101 retained pane IDs but lost `tmuxSession`, `tmuxPaneLeftAgent`, and
  `tmuxPaneRightAgent` after a repair.
- `clearStaleTmuxBridgeState` deliberately clears exactly those three fields
  after one failed tmux liveness probe; the observed rewrite landed 356 ms
  after bridge delivery, matching the worker polling path.
- The Governess resolver also performs an unnecessary startup rewrite of its
  loaded snapshot, and typed reads discard unknown future fields.
- Claude config GC and startup orphan cleanup both treat an absent
  `tmuxSession` plus a dead launcher PID as proof of death, despite active
  lifecycle state.

## Safety boundary

- Work is isolated from deployed commit `194fc7381b21d508c5843437ac82c1a4a5488495`.
- Run 101 and its tmux server, panes, Governess, app server, and bridges remain
  untouched.

## Regression evidence

- Before the fix, the active bridge liveness regression reproduced the exact
  field fingerprint: session and left/right roles cleared, stable pane IDs
  retained, `updatedAt` changed, and Claude MCP removal attempted.
- Before the fix, Claude config GC attempted to remove the registration for an
  active no-session manifest with a dead detached launcher.
- Before the fix, orphan cleanup classified the same manifest as abandoned and
  advanced into owned-process inspection.
- Governess configuration resolution rewrote the manifest bytes even though it
  had no field change to persist.

## Verification evidence

- Focused: Governess 70 pass; bridge 91 pass; Claude config GC 5 pass; run
  process cleanup 16 pass.
- `bun run check`, targeted TypeScript compilation, build, and
  `git diff --check`: pass.
- The first sandboxed canonical-suite attempt reached the local WebSocket test
  and could not bind a loopback port. The exact test and then the full canonical
  suite passed outside the network-restricted sandbox.
- No live binary was installed and run 101 was not mutated.
