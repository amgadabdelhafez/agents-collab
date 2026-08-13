# D1 Verification

Recorded: 2026-08-12 (America/Los_Angeles)

## Identity

- Task: `harvto-d1-live-peer-expiry`
- Base SHA: `52e244b8d49258ea1768580fba2042719030d884`
- Implementation commit: pending explicit-path commit
- Claude exact-SHA review: pending
- Baseline failures: none

## Focused proof

```text
cd loop-fork && bun run test:file -- tests/loop/governess-p0-runtime.test.ts --test-name-pattern 'D1 live liveness callback suppresses ttl expiry and queue-depth dead-letter terminalization'
```

Result: 1 pass, 15 filtered, 0 fail. Same named test and seven assertions as baseline.

```text
cd loop-fork && bun run test:file -- tests/loop/governess-p0-runtime.test.ts
```

Result: 16 pass, 0 fail, 88 expectations. Named controls prove live and unknown retention,
confirmed-dead expiry/dead-letter, retained ceiling, later-dead single terminalization,
supersession at ceiling, old/fixed journal parsing, exact target-liveness composition, and one
effective delivery plus one delivered resolution across repeated recovery reads and two consumes.

```text
cd loop-fork && bun run test:file -- tests/loop/bridge.test.ts
```

Result: 109 pass, 0 fail, 473 expectations. Backpressure formatting is distinct from queued;
`appendBridgeMessage` throws rather than returning an unjournaled identity as success.

```text
cd loop-fork && bun run test:file -- tests/loop/tmux-control.test.ts
```

Result: 6 pass, 0 fail, 21 expectations. Exact pane live/dead evidence is bounded; session
dead/unknown, whole-server throw, timeout, and malformed pane output remain unknown.

## Repository gates

```text
cd loop-fork && bun run check
```

Result: pass; 865 files checked.

```text
cd loop-fork && bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts
```

Result: pass, exit 0.

```text
cd loop-fork && bun run build
```

Result: pass; 3,050 modules bundled and compiled.

```text
cd loop-fork && bun run test:ci
```

Result: pass, exit 0. All 77 sorted `tests/**/*.test.ts` files ran serially under
`LOOP_TEST_CERTIFICATION_MODE=single-file`; no file failed.

```text
cd loop-fork && ./harness preflight && ./harness stop-gate
```

Result: `preflight passed: harvto-d1-live-peer-expiry` and
`stop gate passed: harvto-d1-live-peer-expiry`.

```text
scripts/verify.sh harvto-d1-live-peer-expiry harvto-d1-live-peer-expiry
```

Result: pass, exit 0. Verifier repeated lint, canonical typecheck, build, and all 77 serial test
files, then reported `baseline allowlist empty: runs/harvto-d1-live-peer-expiry/eval.json` and
`=== verify.sh complete ===`.

## Compatibility and scope

- Pre-fix message lines without `retainedReason` parse in fixed code.
- Fixed message lines use only optional `retainedReason: "queue-pressure"`; unknown properties
  remain ignored and no event kind or queue-health field changed.
- `maxRetained` bounds pending identities per target, not append-only journal bytes. Default is 33;
  custom `maxOutstanding` derives one extra retained slot unless explicitly overridden.
- No rendered UI changed; screenshots are not required.
- Repo-root `runs/harvto-d1-live-peer-expiry/eval.json` has `verdict: "pass"` and an empty
  `baseline_failures` list.

## Pre-commit scope proof

- `git diff --name-only` was empty after explicit staging; only untracked `.loop/` helper
  artifacts remain outside the index.
- `git diff --cached --name-only` contains only D1 source, tests, promoted D1 Harness artifacts,
  D1 promotion metadata, the D1 matrix hunk, `PLAN.md`, `status.md`, and the repo-root eval.
- No staged path exists in any Harvto checkout or D2-D14 artifact.
- `defect-matrix.md` has one staged hunk, wholly between the D1 and D2 headings.
- `git diff --cached --numstat` exactly matches
  `git diff --cached --numstat --ignore-all-space`; no whitespace-only reformat is present.
- `git diff --cached --check` passes.
