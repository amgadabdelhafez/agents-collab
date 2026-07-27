# Loop 56 live runtime proof

Date: 2026-07-27
Run: `/Users/amgad/.loop/runs/harvto-b1e274e66299/56`
Session: `harvto-loop-56`

## Hot-swap

- Live-proof build SHA-256: `6a65882d0932c713d1a5a5142789fdf77c6a5915e8bf3a5141376e5ef57636fd`.
- Final source-aligned build and deployed SHA-256:
  `d775e2dc535c984824b44107c6ae5a0af92423bb52ff9df85caa8625c3342bad`.
- Previous deployed SHA-256: `6ede4dbabd022b5d23fc49d8ec54c74bc0f3453f7897369eea17862910f0558f`.
- Recovery copies:
  `/tmp/loop-harvto-56-pre-nanny-bounded-inspection-6ede4dba` and
  `/tmp/loop-harvto-56-pre-final-nanny-bounded-inspection-6a65882d`.
- Only governess pane `%6` was respawned: PID `44086` became `89186` for the
  live proof, then `11514` for the final source-aligned executable.
- Claude pane `%0` stayed PID `3965`; Codex pane `%1` stayed PID `3967`.
- Nanny pane `%5` stayed PID `34397`; Au Pair pane `%4` stayed PID `34391`.
- Pre-swap and post-proof helper load was `active 0`, `queued 0`.

## Replay-shaped bounded inspection

- Job: `69768c20-a361-4a46-8c9a-f12e5b7fa527`.
- Shape: unprofiled, low-risk `inspect`, one read scope (`README.md`), one
  `inspect` capability, no write scope, no authority.
- Persisted decision: `target: utility`, `tierId: utility-nanny`.
- Workspace root: `/Users/amgad/harvto`; adopted read scope: `README.md`.
- Result: completed in 7.792 seconds after one successful `read_file` call.
- Evidence: returned `# HARVTO` from `README.md:1`.
- Usage: `harness: pi-sdk`, `role: Nanny`, `tierId: utility-nanny`,
  `provider: loop-nanny`, model `mlx-community/Qwen3.6-35B-A3B-4bit`,
  Pi `0.82.1`, two model calls, one tool call, cost `0`.
- No Au Pair job was created for this request.
- The external `gemini` result target was drained twice; the second read was
  empty. The board returned to helper `pending 0`, `active 0`, `queued 0`.

## Post-proof board

- Helper success: `9/14` (`64%`).
- Helper route share: `14/198` (`7%`).
- Nanny context capsule: `6a61ad5f...`, version 1.
- Bridge helper messages: `in 14`, `out 14`, `pending 0`.

After the final source-aligned rebuild, the restarted board was healthy at
`active 0`, `queued 0`, routing `pending 0`, and bridge `pending 0`. Live agent
traffic had advanced totals to 15 helper routes out of 215 candidates; Claude
and Codex still held PIDs `3965` and `3967`.
