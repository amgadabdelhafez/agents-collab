# bridge-long-lived-idle-wake task log

- Producer incident: run 132 had no successful Claude tmux `notified` records.
  Four Claude-bound handbacks required manual wakes; message
  `9688794f-b50f-4ebc-9960-40411af5d57c` waited from 08:27:21Z to
  08:47:01Z while the Claude hook journal remained `input-required`.
- Lineage: isolated worktree and branch `codex/bridge-long-lived-idle-wake`
  start at supervisor-cleared `ccab7bff91198f54f2baab23912fafccb09f443c`.
  `origin/main` was not used because it does not contain that cleared tip.
- Root cause: the existing classifier strips only SGR-2 dim spans. Claude Code
  2.1.221 renders generated prompt suggestions with its semantic `suggestion`
  color, whose shipped themes resolve to ANSI blue/bright-blue or one of four
  RGB values. The colored ghost therefore looked like a foreign human draft.
- RED: the producer-shaped 2.1.221 palette readiness test failed before the
  change while the original dim case remained green.
- Fix: Claude composer parsing now strips only SGR-2 spans and the exact shipped
  2.1.221 semantic suggestion palette. Unknown colors and any residual typed
  text remain blocking foreign drafts. Routing, retry timing, claim scope, and
  non-Claude parsing are unchanged.
- Proof: bridge suite 104/104; full sequential suite green with an empty named
  baseline list; lint, typecheck, build, and `git diff --check` green. The first
  proxy test attempt inside the filesystem sandbox could not bind a local port;
  the exact proxy test and the full suite both passed outside that network
  restriction.
- Release boundary: no live run, installed binary, merge, or push was mutated.
