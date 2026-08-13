# D4 Fix Verification

## Correction

`processPendingUtilityRoutes` now reconciles every durable `routed-peer` job before ordinary
utility recovery. It rediscovers the exact `review_request`, repairs a missing append with stable
dedupe key `utility-peer-route:<jobId>`, requires durable delivery before accepting a response,
correlates the exact reverse source/target and task ID (plus `replyTo` when present), and records one
deterministic terminal utility event. Existing bridge `blocked`, `dead-letter`, `expired`, and
`superseded` evidence fails the route once. Pending and unknown routes remain recoverable.

Production change is limited to `src/loop/utility-runtime.ts`; no journal schema or D1 bridge
liveness/retention policy changed.

## Regression coverage

- `D4 live peer consumption and correlated response terminalize routed-peer once across replay`
- `D4 routed-peer reconciliation recovers the dispatch crash window without duplicate requests`
- `D4 unknown peer remains recoverable and durable dead-letter fails once across replay`

These cover exact positive liveness, durable consumption and response correlation, stable request
dedupe, restart epochs, one terminal event, unknown fail-closed recovery, durable terminal failure,
and unrelated supervisor traffic.

## Commands and results

All commands ran on 2026-08-13 from `loop-fork` unless otherwise noted.

| Command | Result |
|---|---|
| `bun run test:file -- tests/loop/utility-runtime.test.ts` | pass: 55, fail: 0 |
| `bun run test:file -- tests/loop/bridge.test.ts` | pass: 109, fail: 0 |
| `bun run test:file -- tests/loop/governess-p0-runtime.test.ts` | pass: 16, fail: 0 |
| `bun run test:file -- tests/loop/utility-store.test.ts` | pass: 15, fail: 0 |
| `bun run check` | pass: 870 files checked, no fixes required after exact-path formatting |
| `bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts` | pass |
| `bun run build` | pass |
| `bun run test:ci` | pass: all 77 serial test files, no failing file |

| `./harness preflight --json harvto-d4-live-peer-unconsumed` | pass: eval status `pass` |
| `./harness stop-gate --json harvto-d4-live-peer-unconsumed` | pass: required dimension `unit` |
| `scripts/verify.sh harvto-d4-live-peer-unconsumed harvto-d4-live-peer-unconsumed` (repo root) | pass: lint, typecheck, build, all 77 serial test files, and empty baseline allowlist |

## UI

No rendered UI changed. Screenshots are not required.
