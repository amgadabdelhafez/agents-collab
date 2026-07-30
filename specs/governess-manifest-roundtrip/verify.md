# Verification

- `bun run test:file -- tests/loop/run-state.test.ts`
- `bun run test:file -- tests/loop/governess.test.ts`
- `bun run test:file -- tests/loop/bridge.test.ts`
- `bun run test:file -- tests/loop/claude-config-gc.test.ts`
- `bun run test:file -- tests/loop/run-process-cleanup.test.ts`
- `bun run test:ci`
- `bun run check`
- `bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts`
- `bun run build`
- `git diff --check`
- `runs/governess-manifest-roundtrip/eval.json` records an empty
  `baseline_failures` list and a separate evaluator verdict.
