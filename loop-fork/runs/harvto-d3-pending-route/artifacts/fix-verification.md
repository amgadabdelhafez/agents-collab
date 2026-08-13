# D3 Fix Verification

## Correction

Governess now owns the missing-router branch whenever a durable run exists but current workspace,
driver, or peer evidence is incomplete. It advances only the current utility epoch, reads durable
`pending-route` jobs, and records one deterministic `escalated` state transition with decision
`routing-owner-unavailable`. Repeated cycles see no pending job and append nothing.

Normal `processPendingUtilityRoutes` behavior remains unchanged when a complete routing context
exists. This preserves temporary full-tier backlog and later capacity recovery, existing
`utility-unavailable` decisions, peer review, and D1/D4 bridge behavior. The route-reason type adds
the explicit attributable failure without changing the journal schema.

## Regression coverage

- `D3 Governess fails closed once when pending utility work has no routing peer` proves the real
  Governess owner branch, two cycles, one durable transition, and no synthetic result.
- `D3 missing routing owner escalates once and stale replay cannot mutate` proves stale epochs make
  no mutation and same-epoch replay appends no duplicate.
- Existing utility-runtime controls prove an unavailable eligible tier routes with
  `utility-unavailable`, a full four-slot pool leaves a fifth job pending, and that job routes once
  after capacity frees.
- Existing utility-store malformed-journal and epoch-fencing controls, D1 liveness controls, and D4
  response/replay controls remain green.

## Commands and results

All commands ran on 2026-08-13 from `loop-fork` unless noted.

| Command | Result |
|---|---|
| `bun run test:file -- tests/loop/governess.test.ts` | pass: 79, fail: 0 |
| `bun run test:file -- tests/loop/utility-runtime.test.ts` | pass: 56, fail: 0 |
| `bun run test:file -- tests/loop/utility-store.test.ts` | pass: 15, fail: 0 |
| `bun run test:file -- tests/loop/bridge.test.ts` | pass: 109, fail: 0 |
| `bun run test:file -- tests/loop/governess-p0-runtime.test.ts` | pass: 16, fail: 0 |
| `bun run check` | pass: 875 files checked, no fixes applied |
| `bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts` | pass |
| `bun run build` | pass |
| `bun run test:ci` | pass: all 77 serial test files under canonical non-PTY execution |
| `./harness preflight --json harvto-d3-pending-route` | pass: eval status `pass` |
| `./harness stop-gate --json harvto-d3-pending-route` | pass: required dimension `unit` |
| `scripts/verify.sh harvto-d3-pending-route harvto-d3-pending-route` (repo root) | pass: lint, typecheck, build, all 77 serial test files, and empty baseline allowlist |

The first full-suite attempt used a PTY, which forced an 80-column board and invalidated 12
viewport assertions in `governess.test.ts`; the same file had already passed 79/79 without a PTY.
The canonical non-PTY `bun run test:ci` rerun passed all 77 files. This invocation artifact is not a
baseline failure and no assertion or production behavior was changed to hide it.

## UI

No rendered UI behavior changed. Screenshots are not required.
