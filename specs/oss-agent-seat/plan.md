# Plan: Provider-Neutral OSS Agent Seat

1. Separate launchable agents from retired manifest identities.
2. Replace Gemini/Cursor/Copilot CLI surface with the provider-neutral `oss`
   surface and OpenCode-backed command adapter.
3. Generate a run-scoped OpenCode config containing only the loop bridge and
   explicit permissions, with credentials resolved outside the repository.
4. Extend tmux, sessions, hooks, bridge routing, governess, recovery, and usage
   normalization for the OSS seat.
5. Preserve read-only historical parsing and reaping for retired identities.
6. Add producer-backed regression coverage and run the governed verification.
