# D-010: Installer symlink output

## Status

Queued for a fresh isolated governed loop. Do not implement this defect in the
tmux-socket-normalization worktree.

## Confirmed failure

The installer can leave or report the installed output as a symlink, so a
successful command does not prove the live executable is the reviewed build.

## Required behavior

- Install atomically to a regular file at the final destination.
- Reject symlink, non-regular, and path-redirection destinations.
- Verify the installed file SHA-256 against the reviewed build after rename.
- Preserve an atomic backup and restore it on any failed verification.

## Regression evidence required

- Existing symlink, dangling symlink, regular file, and interrupted-install
  fixtures.
- Post-install proof includes file type, exact SHA-256, and live smoke.
