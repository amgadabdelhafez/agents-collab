# Launch smoke reservation binding

## Problem

The realistic large-prompt smoke injects `LOOP_RUN_ID` and predicts a manifest
at that named path. New paired launches are now reserved atomically and receive
the next numeric run ID before the child launcher starts. The runtime is
correct, but the release instrument fails before it can verify the live session.

## Required behavior

- Treat the isolated launch's persisted manifest as producer truth.
- Require exactly one manifest under the isolated case's expected repo ID.
- Reject zero or multiple manifests rather than selecting one heuristically.
- Read the actual `runId` from that manifest and require its storage path,
  `repoId`, and `runId` to agree.
- Keep all existing charter, tmux, pane, failure-exit, readiness, hash-mismatch,
  and host-isolation checks.
- Verify the current six-pane topology: two agents, Governess, Nanny, Au Pair,
  and one consolidated activity pane.
- Do not weaken runtime launch reservation or restore environment authority over
  new run allocation.

## Release boundary

This repair changes only the release smoke. The memory-lineage binary remains
byte-identical until the corrected instrument passes and receives exact-SHA
review.
