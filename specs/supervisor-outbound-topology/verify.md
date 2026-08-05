# Verification

- An initialized agent bridge lists `supervisor` in `send_message.target`.
- In a Claude/Codex manifest, Claude can send an escalation to `supervisor` and
  the ledger records exactly one pending message with that target.
- A `supervisor` MCP session receives that message and records exactly one
  delivered resolution.
- Bridge status reports the supervisor pending count before the drain and zero
  afterward.
- A send to absent Gemini still fails with MCP `-32602` and writes no message.
- Focused bridge tests, static checks, build, mandatory sequential suite, and
  empty named baseline allowlist pass at the exact candidate SHA.
