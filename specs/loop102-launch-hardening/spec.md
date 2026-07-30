# Loop-102 launch hardening

## Problem

Run 102 exposed two launcher defects on the exact deployed binary
`ca7df916f4431ade5b4e1af7d7cf33eae0c31eca0c99792cd0fe9028b43dacaf`:

1. Claude emitted stable permission-warning output before its delayed
   development-channel confirmation. The launcher treated that stable output as
   readiness, pasted the hash-bound bootstrap too early, and lost it in the
   confirmation screen. Claude required manual confirmation and bootstrap
   reinjection.
2. A detached paired launch had no stdout terminal dimensions, so tmux inherited
   `80x24`. The two agent panes rendered at roughly 40 columns until the
   supervisor manually resized the session to `213x53`.

## Required outcome

- A new Claude pane must not receive its launch bootstrap until the launcher has
  positively observed Claude's empty main input prompt after clearing any known
  trust, bypass-permission, or development-channel confirmations.
- Stable but non-ready startup output must never count as readiness.
- Prompt readiness must be bounded. If Claude does not reach a recognized input
  prompt within the startup deadline, launch fails nonzero and follows the
  existing failed-start cleanup and manifest-terminalization path.
- A paired tmux session created without valid terminal dimensions must be
  created at `220x60`. Valid dimensions from an attached terminal remain
  authoritative.
- The bootstrap continues to travel through the existing hash-bound file and
  tmux buffer transport. No prompt body is added to argv.
- Existing session identity, manifest ownership, bridge configuration, helper
  layout, and live run 102 remain untouched.

## Acceptance criteria

1. A regression test holds Claude on stable warning output for longer than the
   old settle threshold, then presents the development-channel confirmation.
   The test proves confirmation happens before any `load-buffer`,
   `paste-buffer`, or bootstrap-submit command.
2. A regression test proves a stable warning that never reaches the main prompt
   fails closed and does not paste a bootstrap.
3. Existing trust and bypass prompts remain auto-confirmed.
4. Paired `new-session` uses `-x 220 -y 60` when terminal size is absent or
   invalid, and preserves a valid supplied terminal size.
5. A real tmux smoke with a realistic prompt positively observes the named
   session, both agent panes, non-empty manifest `tmuxSession`, autonomous
   bootstrap completion, detached geometry, and nonzero exit on missing
   workspace.
6. Focused tests, the full suite, build, Harness preflight/stop-gate, and an
   independent exact-SHA review all pass before deployment.
7. Any binary deployment is announced to the supervisor channel with commit,
   SHA-256, and one-line summary. Run 102 is not restarted.

## Non-goals

- Changing Claude/Codex model selection, routing policy, or helper permissions.
- Reworking tmux pane proportions beyond supplying a safe detached-session
  canvas.
- Removing Claude development channels or the run-scoped bridge.
- Restarting or otherwise mutating the active `harvto-loop-102` session.
