# Full-suite baseline comparison

Date: 2026-07-27

The candidate full suite completed with 1,032 passing tests and four failures.
All four are unrelated Codex launch/config expectation drift:

- `preparePairedOptions creates a loop-scoped Codex home without global MCP config`
- `runAgent launches Codex app-server with loop-scoped Codex home`
- `buildCommand carries Codex bridge approval config for legacy exec`
- `startPersistentAgentSession enables persistent Codex threads`

The same two test files on parent branch `codex/worker-routing-integrated-safe-plans`
at `6e2ad81` reproduce the same four failures (25 pass, 4 fail). The current
environment supplies `gpt-5.6-sol`, `xhigh`, and `standard` Codex defaults while
those tests still expect the older static configuration.

Task-specific proof is clean: the Harness unit command passed 277 tests across
the context loader, router, bridge, runtime, observability, workspace, tool
broker, and governess suites. `bun run build` and `git diff --check` pass.
