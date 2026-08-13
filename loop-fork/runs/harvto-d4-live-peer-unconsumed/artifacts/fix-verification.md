# D4 Fix Verification

## Correction

`processPendingUtilityRoutes` now reconciles every durable `routed-peer` job before ordinary
utility recovery. It rediscovers the exact `review_request`, repairs a missing append with stable
dedupe key `utility-peer-route:<jobId>`, requires durable delivery before accepting a response,
correlates the exact reverse source/target and task ID (plus `replyTo` when present), and records one
deterministic terminal utility event only for an explicit `decision`. Existing bridge `blocked`,
`dead-letter`, `expired`, and `superseded` evidence fails the route once. Acknowledgements, generic
or legacy-untyped messages, pending routes, and unknown liveness remain recoverable.

Production change is limited to `src/loop/utility-runtime.ts`; no journal schema or D1 bridge
liveness/retention policy changed.

## Regression coverage

- `D4 peer instruction requires decision while ack and untyped replies stay nonterminal across
  replay`
- `D4 routed-peer reconciliation recovers the dispatch crash window without duplicate requests`
- `D4 unknown peer remains recoverable and durable dead-letter fails once across replay`

These cover exact positive liveness, durable consumption and response correlation, non-terminal
acknowledgements and untyped progress, stable request dedupe, restart epochs, one terminal event,
unknown fail-closed recovery, durable terminal failure, and unrelated supervisor traffic.

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

## Exact-SHA review correction

Claude returned zero-write `REVISE` for
`26e5cfd6998602ff7c2452c9006ad13fe26449dc` via
`c96f267b-ad2b-48ea-a273-2c8509eb2610`. The accepted finding was that `ack` and legacy-untyped
responses could win before the actual verdict. Legacy missing types normalize to `message` during
durable read, so the fail-closed terminal predicate now accepts only `type: "decision"`. The named
regression appends an `ack`, then a raw untyped progress row, proves the job remains `routed-peer`,
then appends the decision and proves exactly one completed result across replay.

Claude returned a second zero-write `REVISE` for
`c3468c2f2b83eb8ec104a895c5d6da49dd90f7dc` via
`46fbee8b-b835-4c03-913e-1e2d9224f19e`: the decision-only consumer was not coupled to a producer
instruction. The peer `review_request` now explicitly requires the verdict to use bridge message
type `decision`, and the same regression asserts that exact instruction before proving ack and
legacy progress remain nonterminal and the decision completes once.

The review's non-blocking backpressure note is documented in the settled contract: when bridge
pressure refuses a pre-append request, reconciliation attempts dispatch once per Governess cycle,
keeps the utility job recoverable, and retains D1 bridge queue bounds. No additional queue policy or
journal schema was introduced.

Post-correction verification repeats every required result in the command table above: focused
utility-runtime/bridge/D1/utility-store controls pass; check, canonical typecheck, build, and all 77
serial test files pass; Harness preflight and stop-gate pass; and the repo-root verifier passes its
second lint/typecheck/build/full-suite run plus the empty baseline allowlist gate.
