# Verification

- A case with no manifest exits nonzero.
- A case with two manifests exits nonzero.
- A case with one manifest returns its exact path and persisted run ID.
- The exact-prebuilt realistic smoke passes with a source prompt above 8 KiB.
- The smoke positively verifies the named tmux session, both agent panes,
  non-empty manifest binding, the six-pane consolidated layout, delayed Claude
  readiness, preserved timeout workspace, hash mismatch refusal, and
  missing-workspace nonzero exit.
- Candidate SHA-256 is unchanged before and after the smoke.
