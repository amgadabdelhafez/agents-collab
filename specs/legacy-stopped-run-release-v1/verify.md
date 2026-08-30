# Verification

Allowed implementation surfaces are `loop-fork/src/cli.ts`,
`loop-fork/src/loop/run-state.ts`, `loop-fork/src/loop/launch-reservation.ts`,
their focused first-party tests, this spec bundle, and
`runs/legacy-stopped-run-release-v1/**`.

Required checks:

- Producer: changed, idempotent, dead/reused PID, live/ambiguous PID,
  live/unknown tmux, malformed evidence, missing/rebound identity, and
  concurrent-change preservation.
- Command: exact grammar, deterministic JSON, nonzero refusal, and no startup
  maintenance or launch behavior.
- Focused test files, `bun run check`, scoped typecheck, `bun run build`,
  `git diff --check`, and one `bun run test:ci` all pass with empty failure
  sets.
- Frozen candidate receives literal `PASS` from a zero-write Claude Code
  harness whose runtime evidence identifies `openrouter` and
  `z-ai/glm-5.2`; no secret value is persisted.
- `scripts/verify.sh legacy-stopped-run-release-v1
  legacy-stopped-run-release-v1` passes after the evidence-only successor.
