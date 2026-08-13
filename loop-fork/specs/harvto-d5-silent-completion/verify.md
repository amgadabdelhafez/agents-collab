# D5 Durable Supervisor Completion Verification

## Acceptance checks

- Named regression fails unchanged base because the manifest reaches `completed`/`done` while no
  exact completion exists in the supervisor inbox.
- Fixed completion's structured `bridge.jsonl` supervisor message exactly repeats manifest
  `repoId`, bound repository root, `runId`, and `sourceTaskSha256` plus Git HEAD captured before
  terminalization; its `taskId`, `threadId`, and `dedupeKey` bind the same identity.
- Completion is durable in the bridge journal and remains visible after process restart.
- Supervisor delivery followed by replay does not append a second effective completion.
- Missing attribution or durable enqueue failure cannot leave an apparently healthy completion.
- Failed, stopped, input-required, max-iteration, and review-failed controls emit no success.
- Existing supervisor polling, agent bridge, D1 liveness/retention, D3 route ownership, and D4
  peer-decision controls remain green.
- No rendered UI changed; screenshots are not required.

## Commands

```bash
cd loop-fork
bun run test:file -- tests/loop/00-paired-loop.integration.test.ts
bun run test:file -- tests/loop/paired-loop.test.ts
bun run test:file -- tests/loop/bridge.test.ts
bun run test:file -- tests/loop/governess.test.ts
bun run test:file -- tests/loop/utility-runtime.test.ts
bun run check
bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts
bun run build
bun run test:ci
./harness preflight --json harvto-d5-silent-completion
./harness stop-gate --json harvto-d5-silent-completion
```

Repo root:

```bash
scripts/verify.sh harvto-d5-silent-completion harvto-d5-silent-completion
```

Read the canonical task ID from `./harness status --json`; never assume the parked slug. Harness
eval `runs/<canonical-task-id>/eval.json` requires every `dimensions[*].status` to pass. Repo-root
eval `../runs/<canonical-task-id>/eval.json` requires top-level `verdict` or `result` exactly
`"pass"`, present empty `baseline_failures`, and no truthy baseline-failure key. Baseline allowlist
entries are test names, never tolerated counts. `bun run test:ci` is the complete serial
certification under `LOOP_TEST_CERTIFICATION_MODE=single-file`; filtered tests do not substitute.
