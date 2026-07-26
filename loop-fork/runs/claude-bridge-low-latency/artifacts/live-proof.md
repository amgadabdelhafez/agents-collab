# Live run-38 proof

Run directory: `/Users/amgad/.loop/runs/harvto-b1e274e66299/38`

- Patched installed binary SHA-256:
  `d4a8f01751c1dc0964ce9bcb9aeebd8a5f7901caa1c038e4c057b28b7954af3c`
- Codex bridge MCP PID after reload: 4843.
- Source: Codex; target: Claude.
- Message ID: `d12cc542-b2c9-449c-b0c1-a06c4721391a`.
- Durable message event: `2026-07-26T06:02:07.427Z`.
- Durable delivered event: `2026-07-26T06:02:07.578Z`.
- End-to-end bridge acknowledgement latency: 151 ms.
- Delivery reason: `sent to claude tmux pane`.
- Ledger occurrence count: exactly one message row and one delivered row.
- Visual evidence: the full `Message from Codex via the loop bridge` request
  appeared in Claude pane `%0` while Claude continued its active work.
- Pane isolation: Claude remained PID 86033, Governess PID 40995, and judge PID
  45739. Only the Codex pane was respawned, on the same persistent thread, after
  its prior websocket client exited during the app-server replacement.
