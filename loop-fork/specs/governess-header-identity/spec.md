# Governess header identity

## Required behavior

- The dashboard first line merges the loop name and absolute path directly into
  the time/status line:
  `harvto-loop-34 · /Users/amgad/harvto · 15:32:31 · wall 3h · ...`.
- The line does not repeat `governess` or `run 34`; both are already expressed
  by the pane title and loop name.
- The tmux governess border/native title is short:
  `governess.harvto-loop-34`.
- Both values use the actual session, run id, and absolute working path and
  continue to self-heal on every supervision cycle.
- Agent panes and composer contents are not changed.

## Acceptance

- Unit tests assert the exact merged first line and exact short pane identity.
- A live focused refresh preserves agent PIDs and composer contents.
- Live tmux metadata and a terminal screenshot confirm the requested layout.
