# D-005: xchan recv returns the initialize response

Status: queued
Severity: P1
Subsystem: Durable supervisor channel
First confirmed: 2026-08-07

## User-visible failure

Both required `xchan recv codex` drains in the same harness-engineering turn
failed with:

```text
xchan: unparseable response: 'content'
raw response (first 500): {"id":1,"jsonrpc":"2.0","result":{"capabilities":{"tools":{}},"protocolVersion":"2024-11-05","serverInfo":{"name":"loop-bridge","version":"1.0.33"}}}
```

The wrapper received or selected the MCP initialize result instead of the
`receive_messages` tool result, so it did not prove that the Codex queue was
drained.

The failure recurred on 2026-08-09 under installed loop v1.0.38 for both
`xchan recv codex` and an attempted `xchan send`. Recovery of the AI-CUR Run 9
incident required reading the durable `bridge.jsonl` ledger directly. Sending
the recovery reply required a protocol-correct initialize, initialized
notification, and correlated `id=2` tool call through the same bridge.

It recurred again at 2026-08-09T03:57Z while the durable ledger already held
AI-CUR incident message `c7fd77d5-0c24-4625-ba1c-b403f4d251be`. Both the start
and end `xchan recv codex` calls returned only the `id=1` initialize result, so
the incident remained undrained even after the harness owner recovered Run 11
and the supervisor received the correlated recovery reply. This proves the
failure can hide actionable mail rather than merely misreport an empty queue.

## Required behavior

- Correlate JSON-RPC responses by request ID and return the `tools/call`
  response, independent of output order or buffering.
- Fail with an exact transport/protocol reason if the tool response is absent.
- Never report a successful drain from an initialize response.
- Preserve the durable ledger and exact message IDs across retry.

## Acceptance tests

- `send`, `recv`, and `log` are tested against reordered, delayed, coalesced,
  and multi-line JSON-RPC responses.
- `recv` returns only the decoded `receive_messages` result for request ID 2.
- A missing request-ID-2 response exits nonzero without consuming or losing
  mail.
- A producer-backed live test sends a uniquely identified message, drains it
  once, verifies the durable ledger, and proves a second drain is empty.

## Delivery lane

Implement in a fresh isolated governed loop. Do not patch the wrapper inline in
the current tmux socket-normalization task.
