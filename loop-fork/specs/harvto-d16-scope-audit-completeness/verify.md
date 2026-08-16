# D16 Verification

## Exact-base red

- Use base `ee559c4f75dfe36e2dd61c607d48a3aba4faa500` with production unchanged.
- Run one named test that gives the scope-audit path a known Git/broker set, omits at least one path
  from synthesized output, and expects fail-closed consumer status.
- Preserve command, exit code, known records/count/hash, synthesized result, persisted result, and
  decisive failure under `runs/harvto-d16-scope-audit-completeness/artifacts/red/`.

## Focused controls

Run the source-selected subset of:

```bash
bun run test:file -- tests/loop/utility-tools.test.ts
bun run test:file -- tests/loop/utility-runtime.test.ts
bun run test:file -- tests/loop/utility-store.test.ts
bun run test:file -- tests/loop/utility-execution-tier.test.ts
bun run test:file -- tests/loop/task-router.test.ts
bun run test:file -- tests/loop/bridge.test.ts
```

Required named controls cover added/untracked, deleted, rename/copy, staged, unstaged,
committed-range, tracked routing-ignored metadata, synthesized omission, count/hash tamper,
duplicate/malformed/truncated evidence, replay, legacy non-scope results, and a validated clean zero
set.

## Mandatory suite

```bash
bun run check
bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts
bun run build
LOOP_TEST_CERTIFICATION_MODE=single-file bun run test:ci
```

Then write passing Harness and repository-root eval schemas with empty `baseline_failures`, run
Harness preflight and stop-gate, and run from repository root:

```bash
scripts/verify.sh harvto-d16-scope-audit-completeness harvto-d16-scope-audit-completeness
```

No UI capture is required unless rendered UI behavior changes.

## Scope proof and review

- Treat `git status --porcelain=v2 --untracked-files=all`, unstaged/cached name-status, and exact
  committed-range diff-tree output as authoritative until the fix itself is reviewed.
- Compare path lists and normal versus ignore-all-space numstats; pass diff checks and D16-only
  exclusions before explicit staging.
- Obtain Claude zero-write `PASS` for the exact committed SHA before one Harness close.
