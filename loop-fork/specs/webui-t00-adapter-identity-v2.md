# webui-t00-adapter-identity-v2

Task completed 2026-08-25T23:04:55Z, mode planned.

## What was built

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

## Decisions made

- The durable adapter identity is socket path plus PID plus OS process-birth
  identity; session names are routing labels, not identity.
- `manifestRevision` is derived from exact accepted file bytes and is never
  serialized into those bytes.
- Resolved configuration is a frozen strict allowlist built only after paired
  options are applied.
- New Web-facing diagnostics require an explicit persisted adapter context and
  exact `tmux -S`; they do not acquire launch or mutation authority.

## Open items at completion

- T-01 must consume these producer-owned fields through a side-effect-free read
  model. Legacy manifests must continue to surface identity/config as unknown.

## Trajectory

- 001 - initial (2026-08-25T21:27:19Z)
