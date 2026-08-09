# D-017 Paired launch socket binding

## Problem

Paired-run manifests record `tmuxSocket`, but the launch path historically
issued workspace creation, pane setup, readiness, bootstrap, and recovery
commands through ambient tmux. After a restart or when another tmux server is
present, those commands can address a different server from the recorded run.

## Required behavior

- Resolve or validate one launch socket and persist it before the first tmux
  contact or persistent transport is created.
- Bind every tmux command in the paired-start window to that exact socket.
- Preserve existing pane identities when the exact recorded session is already
  live; clear them only for a confirmed cold recreation.
- Use the exact socket in attach calls and every recovery instruction.
- Preserve D-014 fail-closed cleanup ordering and D-015 non-fatal attach
  capability behavior.
- Reject an unavailable or undurable launch socket before creating resources.

## Acceptance

- A cold paired launch test proves every tmux argv contains the same `-S`
  socket and that the manifest is bound before the first probe.
- Existing-session reattach retains stable pane IDs.
- Malformed or undurable socket state fails before resource creation.
- Focused tmux and socket suites, static checks, build, and independent
  zero-write review pass.

## Non-goals

- No control-plane modernization, traces/evals architecture, product-lane
  work, or global install is included in this slice.
