# Bounded tmux control plane

## Problem

Harvto run 98 retained healthy Codex app-server and proxy listeners, but the
tmux server stopped answering control commands. `has-session`, `list-panes`,
`capture-pane`, and `send-keys` clients accumulated indefinitely. Governess
teardown then blocked behind `send-keys`, bridge delivery could block inside a
synchronous liveness probe, and an empty proxy debug log was misread as a
Codex TUI failure even though the replacement never traversed tmux.

## Requirements

1. Every non-interactive harness tmux probe or control command must have a
   finite kill-on-timeout bound. Interactive `tmux attach` is the sole
   deliberate long-running exception.
2. A timed-out liveness probe is `unknown`, never `dead`. Unknown state must
   preserve the manifest, delivery queue, session ownership, and run-owned
   processes; it must not trigger stale-state clearing, fallback delivery, a
   duplicate launch, or destructive recovery.
3. Bridge MCP sends must enqueue durably before attempting immediate delivery
   and return within a finite bound when tmux is wedged. Recovery workers may
   retry after liveness becomes known.
4. Governess rendering, recovery, exit, and replacement checks must not block
   indefinitely. Timeout/unknown evidence must suppress recovery and teardown
   transitions that require a positive tmux fact.
5. Paired launch and resume must fail clearly and nonzero when tmux control is
   unresponsive; it must not report a workspace or start a conflicting one.
6. Codex tmux proxy must preserve a possibly-live session across a liveness
   timeout and stop only on a positive dead-session result after its startup
   grace policy.
7. The deployed cumulative candidate and loop-63 QA authorization remain
   valid; this follow-up ships only after its own exact-SHA review.

## Scope

- Shared bounded tmux command policy.
- Bridge runtime, Codex tmux proxy, paired resume/launch, Governess lifecycle,
  and replay liveness paths.
- Timeout and recovery regressions plus full repository verification.
- No mutation of run-98; its already-authorized teardown stays supervisor-
  owned.
