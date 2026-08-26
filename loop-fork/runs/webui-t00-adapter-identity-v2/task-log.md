# Task webui-t00-adapter-identity-v2

Created: 2026-08-25T21:27:19Z
Mode: planned
Description: Implement formal Web UI T-00 durable tmux adapter identity and immutable redacted resolved configuration.

## What I changed

- Added strict versioned manifest schemas for tmux server identity and the
  redacted resolved paired configuration.
- Derived `manifestRevision` from exact validated persisted bytes while keeping
  it out of serialization and preserving atomic replacement.
- Added Darwin/Linux process-birth parsing, parent-only socket
  canonicalization, and exact-socket diagnostic revalidation.
- Captured identity after liveness in both existing-session and cold-launch
  paired paths without changing launch or control admission.
- Added RED-to-GREEN unit coverage and a real isolated two-socket/reincarnation
  smoke fixture.

## Why

Future read-only Web projections need producer-owned evidence of the exact tmux
server and effective safe configuration. Guessing from default tmux state,
process lists, or raw options would misidentify reincarnated servers and risk
leaking operator inputs.

## Notes

- Exact implementation SHA `a4b8e11b2ade432a87029db5e00d1e5dbb84f780`
  received an independent zero-write PASS.
- Full regression, build, integration, scoped static, and authored diff gates
  pass. Repository-wide formatting retains an unrelated historical-run JSON
  baseline outside this task's scope.
