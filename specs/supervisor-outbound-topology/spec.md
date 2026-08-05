# Supervisor outbound bridge topology

## Problem

A run can receive a ruling from an external supervisor, but its paired agents
cannot reply through the same durable bridge. In loop 134, two Claude attempts
to send an escalation to `gemini` failed with MCP `-32602` because Gemini was
not one of the two pane agents. The supervisor therefore had to poll a separate
ledger for a specially named escalation.

Producer evidence is the live loop-134 bridge report sent at
`2026-08-05T19:10:29.594Z`: inbound supervisor messages were delivered, while
both outbound attempts failed with `Target "gemini" is not part of this run's
declared agent topology`.

## Requirements

1. `supervisor` is a first-class bridge target, distinct from pane agents.
2. A paired agent can enqueue an ACK or escalation to `supervisor` even though
   no supervisor pane exists.
3. A bridge MCP session opened as `supervisor` can drain only the supervisor
   inbox through `receive_messages`.
4. The supervisor target is visible in the `send_message` tool schema and
   pending bridge status.
5. Existing fail-closed pane topology validation remains unchanged for absent
   Claude, Codex, Gemini, Cursor, and Copilot targets.
6. No automatic tmux delivery, pane creation, or main-agent mutation is added
   for the supervisor target. Delivery remains durable and poll-based.

## Non-goals

- Treating the external supervisor as a paired agent, reviewer, driver, or
  recovery target.
- Reusing an absent pane-agent identity such as Gemini as a supervisor alias.
- Mutating a healthy live run during implementation or verification.
