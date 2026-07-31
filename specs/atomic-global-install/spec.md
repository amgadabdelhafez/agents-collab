# Atomic Global Install

## Problem

The global installer removes `~/.local/bin/loop` and then symlinks it to the
binary in the current source worktree. A later build in that worktree therefore
changes the live executable during an unrelated run or audit. Removing the old
target before installing its replacement also exposes a missing-target window.

## Required behavior

1. A successful global install leaves `loop` as a regular, non-symlink file.
2. Installed bytes are an immutable snapshot of the built binary. Later source
   mutation or rebuilds cannot change the installed bytes.
3. Each file is staged under a unique name in the destination directory, made
   executable where applicable, and published by one rename over its target.
4. The installer never removes the live target before the replacement is fully
   staged.
5. A failed staging or replacement operation preserves the existing target and
   removes its own temporary artifact.
6. Generated aliases retain their existing names and arguments and use the same
   atomic regular-file installation behavior.
7. Windows installs use the same same-directory stage-and-replace design while
   retaining `.exe` and `.cmd` names. A rename failure, including a locked
   running executable, preserves the old target and cleans the owned stage.

## Safety invariants

- Tests never read, write, remove, or install `~/.local/bin/loop`.
- The installer never falls back to a symlink.
- A source path must identify a regular non-symlink file.
- The validated source inode is held open and copied from that handle; the
  source pathname is never reopened for copying.
- Temporary files are exclusive, same-directory, and best-effort cleaned after
  every failure.

## Platform evidence boundary

- Same-directory rename atomicity is certified by the Unix/macOS test run.
- The macOS test can verify Windows filenames, payloads, permission branching,
  and fail-closed code paths, but it cannot certify Windows filesystem
  atomicity. Windows replacement semantics require Windows CI or live proof.

## Compatibility

- `bun run install:global` remains the installation entry point.
- Existing Unix and Windows alias contents remain semantically unchanged.
- Existing tmux installation guidance remains unchanged.
