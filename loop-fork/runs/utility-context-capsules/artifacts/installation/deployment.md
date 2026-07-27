# Utility context capsule installation

- Installed at: `2026-07-27T18:33:06Z`
- Source commit: `f132a90b3a2aa95eda21f778daac92a920fa5093`
- Candidate: `/Users/amgad/dev_projects/agents-collab-utility-context-capsules/loop-fork/loop`
- Canonical target: `/Users/amgad/dev_projects/agents-collab/loop-fork/loop`
- Global command: `/Users/amgad/.local/bin/loop` (symlink to the canonical target)
- SHA-256 for candidate, canonical target, and global command: `a7c88a635d36da549a2d8661792670f3ac0e56bbde18888f1c01f22d451a1a18`
- Installed mode: `-rwxr-xr-x`

The candidate was copied to a uniquely scoped temporary file in the canonical
target directory, byte-compared with the candidate, and installed with a
same-directory atomic rename. Post-install hashes matched at all three paths.
The installed executable contains the `UTILITY.instructions.md`,
`CONTEXT_INSUFFICIENT:`, and `context-insufficient` feature markers.

No live tmux loop was restarted or recreated. Future loop processes launched
through the global command will use this binary.
