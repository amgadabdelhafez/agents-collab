# Installation verification

- Installed at: `2026-07-27T20:20:12Z`
- Candidate: `/Users/amgad/dev_projects/agents-collab-compound-worktree-observability/loop-fork/loop`
- Canonical target: `/Users/amgad/dev_projects/agents-collab/loop-fork/loop`
- User command: `/Users/amgad/.local/bin/loop`
- SHA-256: `418a7de391df12cabf29af677989e07e9b9ba7b0ac3fe27b42fefc5654f12b19`
- Method: mode-preserving temporary copy followed by an atomic rename over the
  canonical binary; the existing user-command symlink was preserved.
- Proof: candidate, canonical target, and user command returned the same hash;
  `loop --help` reported v1.0.32; no Loop 54 tmux session existed to restart.
