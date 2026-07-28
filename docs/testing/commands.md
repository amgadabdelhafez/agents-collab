# Test commands

## Focused unit tests

```bash
cd loop-fork
bun test tests/loop/<module>.test.ts
```

## Integration test

```bash
cd loop-fork
bun test tests/loop/00-paired-loop.integration.test.ts
```

## Repository checks

```bash
cd loop-fork
bun run check
bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts
bun run build
bun run test:ci
```

`bun run test:ci` deliberately runs each test file in sorted order. This catches
module-state leaks and lifecycle bugs that an isolated focused test can miss.

## Full task verification

```bash
scripts/verify.sh <feature> <task-id>
```

The task must already have `runs/<task-id>/eval.json` with an empty
`baseline_failures` list. The verifier runs lint, typecheck, build, the complete
sequential test suite, and the baseline gate.

## UI capture

```bash
scripts/capture-ui.sh --out runs/<task-id>/screenshots/
```

UI capture is required only for tasks that change rendered UI behavior.
