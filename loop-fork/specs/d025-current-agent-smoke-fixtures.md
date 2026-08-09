# D-025 Current-agent smoke fixtures

## Problem

The launch smoke producers still request retired Gemini/Cursor seats. Replacing
the names alone is insufficient: the OpenCode executable must report the `oss`
logical role, and synthetic Claude must emit deterministic kickoff hook
evidence expected by the current launcher.

## Required behavior

- Hash-bound OpenCode fixtures identify as logical agent `oss`.
- Synthetic Claude records one run-scoped `UserPromptSubmit` event only after
  it has received and verified the launcher kickoff.
- Active-launch, large-prompt, and paste-submit smokes use current supported
  seats and current bridge targets.
- Fixture-only behavior cannot affect production runtime.

## Acceptance

- Focused fixture tests prove logical role mapping and run-scoped hook output.
- All three migrated smoke producers pass on private exact sockets.
- Shell/Python static checks, diff check, and independent zero-write review
  pass.
