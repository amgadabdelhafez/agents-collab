# Task bridge-mcp-response-drain

Created: 2026-08-04T20:13:28Z
Mode: planned
Description: Drain parsed bridge MCP responses before EOF shutdown

## What I changed

- Drain the parsed request queue and Claude flush queue before MCP shutdown cleanup.
- Wait for the stdout write callback before the short-lived process returns.
- Keep parent-loss termination for live input, but do not interrupt EOF draining.
- Add helper-level and real-process regression coverage for the shutdown boundary.

## Why

The short-lived MCP client can close stdin immediately after sending initialize
and a tool call. The old server armed parent-loss termination while async
request work was still draining and never waited for stdout's final write
callback, so a durable ledger write could succeed while its JSON-RPC response
was lost during process exit.

## Notes

- Focused bridge suite: 102 pass, 0 fail.
- Full sequential suite: pass outside the sandbox. The sandboxed attempt reached
  a localhost integration test and failed to bind its test port; rerunning with
  localhost permission passed.
- No retry was added, so a receive operation cannot be silently repeated after
  it has already drained its queue.
