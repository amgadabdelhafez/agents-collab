# Governess manifest round-trip safety

## Problem

Run 101 lost `tmuxSession`, `tmuxPaneLeftAgent`, and
`tmuxPaneRightAgent` after those ownership fields had been restored. The bridge
runtime deliberately clears exactly those fields after one failed tmux
liveness probe. The observed rewrite followed a bridge delivery by 356 ms,
matching the worker's 250 ms polling path. Separately, both Claude config GC
and startup orphan cleanup treat a readable active manifest with no
`tmuxSession` and a dead launcher PID as dead, even when the owned pane and
bridge processes are still live.

That combination allows a partial manifest rewrite to turn a healthy active
run into a cleanup target.

## Requirements

- A failed or transient tmux liveness probe in the bridge runtime must not
  erase durable topology or deregister the Claude bridge for an active run.
- Resolving or starting Governess must not overwrite restored ownership fields.
- Governess configuration resolution must be read-only and preserve the exact
  restored manifest bytes.
- Startup orphan cleanup must fail closed for an active or unknown-lifecycle
  manifest whose `tmuxSession` is missing, even when its recorded launcher PID
  is no longer alive.
- Claude config GC must likewise preserve the registration when an active run
  is missing `tmuxSession`; a detached launcher PID is not proof of death.
- Cleanup must still reclaim a run when the evidence affirmatively proves that
  its named tmux session and launcher PID are both gone.
- Add a regression that models the observed sequence: restore ownership,
  execute the Governess persistence path, reread, and retain the restored
  fields.
- Do not mutate or restart run 101. Activation is next-loop only after
  independent exact-SHA review.

## Acceptance

- Restored `tmuxSession`, pane IDs, and pane-agent roles survive Governess
  configuration resolution and one false-dead bridge liveness result.
- A false-dead result neither removes an MCP registration nor changes
  `updatedAt`, and the pending bridge message remains queued.
- Claude config GC preserves an active registration with no `tmuxSession` and
  a dead launcher PID.
- A modern manifest with persisted pane IDs but missing role ownership never
  falls back to positional bridge or Governess routing.
- The startup orphan reaper spares an active manifest with no `tmuxSession` and
  a dead launcher PID.
- The reaper still cleans a nonterminal manifest whose named tmux session and
  launcher PID are both absent.
- Focused tests, the full canonical suite, typecheck, build, and diff checks
  pass with an empty baseline allowlist.

## Non-goals

- Repairing run 101's manifest during the active loop.
- Restarting the current tmux server, panes, bridge, or Governess.
- Changing helper routing, redraw policy, or quota-science behavior.
