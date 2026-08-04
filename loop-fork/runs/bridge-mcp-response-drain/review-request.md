# Exact-SHA review request: bridge MCP response drain

## Trigger

Supervisor defect report `27cfb132-87e6-4c5b-a0ad-e7b268e6490b` reported
intermittent empty stdout from short-lived `loop __bridge-mcp` calls even though
the durable message ledger recorded the operation. A same-turn independent
probe through `xchan recv codex` returned only its initialize frame and an
unparseable response, while a direct bridge MCP retry returned the queued
messages.

## Claim

After stdin EOF, the bridge MCP server now drains every already-parsed request,
finishes the Claude notification queue, and waits for stdout's write callback
before cleanup and return. Parent-loss termination remains active while input is
live, but cannot interrupt EOF draining.

## Changes

- Add an explicit stdout flush boundary using the stream write callback.
- Keep parent-loss cleanup conditional on input still being live.
- Move request and notification draining inside the server's protected lifetime.
- Add named helper regressions and a real short-lived two-frame process test.

## Verification

- Focused bridge suite: `102 pass, 0 fail`.
- Real-process regression: initialize plus `send_message` returns response IDs
  `[1, 2]`, exits zero, and persists exactly one message event.
- Complete sequential `bun run test:ci`: pass outside the sandbox. The first
  sandboxed attempt failed only when a localhost integration test could not bind;
  the permitted rerun passed.
- Harness-certified complete suite: pass, artifact
  `runs/bridge-mcp-response-drain/artifacts/unit/verify.log`.
- `bun run check`: pass.
- `bun run build`: pass.
- targeted TypeScript check: pass.
- Harness preflight and stop-gate: pass.

## Boundaries

- No automatic retry was added. In particular, a draining `receive_messages`
  call is never repeated after an ambiguous response.
- No live process, run, channel data, deployment, or release authority changed.
- This request is review only. Deployment requires separate fresh authority.
