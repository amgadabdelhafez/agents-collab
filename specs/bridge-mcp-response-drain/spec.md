# Bridge MCP response drain

## Objective

Guarantee that a short-lived bridge MCP client receives the JSON-RPC response
for every fully parsed request before the server exits after stdin or parent
closure.

## Failure

The standing `xchan` client writes initialize plus one tool call and closes its
input. The intermediary shell can exit or be reparented while an asynchronous
`send_message` request is still draining. The bridge parent-liveness sweep can
then call `process.exit(0)` after the durable ledger append but before stdout
emits the tool response. Clients observe empty output or only the initialize
frame and cannot distinguish success from loss.

## Required behavior

- Parent loss may terminate a bridge whose input remains open.
- Once stdin has ended, parsed requests own shutdown: the server must await its
  request queue and Claude flush queue before returning naturally.
- The fix must not retry `send_message` internally and must not duplicate a
  durable message.
- Persistent Claude and Codex bridge sessions retain their existing parent-loss
  cleanup behavior.

## Authority

This is transport reliability only. It grants no new message, routing, release,
deployment, or lifecycle authority.
