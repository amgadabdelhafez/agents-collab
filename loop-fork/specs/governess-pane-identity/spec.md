# Governess pane identity

## Problem

The governess pane currently receives the generic border label `governess`,
while tmux's native pane title remains the host name. That makes the pane
ambiguous when several loop sessions are open.

## Required behavior

- The governess pane title includes the full tmux session name, explicit run
  number, and unabridged working-directory path.
- The same value is written to the visible pane-border label and tmux's native
  pane title.
- The governess reapplies the identity during every supervision cycle so a
  shell, process, or tmux refresh cannot leave a stale generic title.
- Agent pane labels and agent composer contents remain untouched.

## Example

For session `harvto-loop-34`, run `34`, and cwd `/Users/amgad/harvto`:

`● governess · harvto-loop-34 · run 34 · /Users/amgad/harvto`

## Acceptance

- Unit coverage proves exact composition, startup application, and per-cycle
  self-healing.
- A live focused governess refresh changes only the governess process and shows
  the exact identity through both `@loop_label` and `#{pane_title}`.
- Terminal capture evidence is saved with the run artifacts.
