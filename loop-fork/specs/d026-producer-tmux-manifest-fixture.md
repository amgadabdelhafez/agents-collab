# D-026 Producer tmux manifest fixture

## Problem

The socket compatibility seam needs fixture evidence emitted by the compiled
candidate. A hand-authored manifest cannot certify that the producer actually
persists `tmuxSocket`.

## Required behavior

- A deterministic capture script builds the candidate and launches it in an
  isolated fake-control environment that cannot contact tmux.
- The normalized new-path manifest is derived from captured product output.
- The legacy manifest is derived only by removing `tmuxSocket` from the
  normalized new-path fixture.
- A provenance index records candidate SHA-256, tmux version, command,
  environment, UTC capture time, source/output hashes, and normalization.
- Verification recomputes every recorded fixture hash and reproduces the
  legacy derivation.

## Acceptance

- Capture and normalization are rerunnable without hand-editing fixture bytes.
- The compiled candidate records an absolute socket and deterministic session.
- Fixture hash verification, focused compatibility tests, static checks, and
  independent zero-write review pass.
