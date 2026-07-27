# Tasks: Lower-Agent Delegation Adoption

## T-01 Classification and telemetry

- [x] Implement exact, fail-closed tool-intent classification.
- [x] Add compact append/read helpers for delegation telemetry.
- [x] Cover safe and adversarial fixtures.

## T-02 Claude enforcement

- [x] Extend hook execution with enforce/observe/off modes.
- [x] Queue idempotent existing utility requests for eligible PreToolUse calls.
- [x] Return a valid denial with task follow-up instructions.
- [x] Fail open on unavailable utility or internal error.

## T-03 Codex observation and agent guidance

- [x] Observe candidate app-server items without altering traffic.
- [x] Add mandatory route-first startup and MCP instructions.
- [x] Record explicit `route_task` calls.

## T-04 Visibility

- [x] Add adoption counters and latest reason to the lower-agent pane.
- [x] Ensure all rendered telemetry is compact and secret-safe.

## T-05 Verification and release

- [x] Run focused tests, full tests, build, diff check, and repository verify.
- [x] Capture independent eval in `runs/lower-agent-adoption/eval.json`.
- [x] Prove loop 45 is untouched.
- [x] Atomically update the canonical local loop binary for future loops.
