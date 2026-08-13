# D3 Pending Route Verification

## Acceptance checks

- Named regression fails unchanged base because a durable accepted job remains `pending-route`
  after bounded processing with no lease holder, peer, or routing owner.
- Durable evidence records one `route-requested` event and no decision before the fix.
- Fixed no-owner/no-router and no-eligible-tier cases receive one attributable durable decision and
  do not appear healthy.
- Stale epoch/authority and malformed evidence fail closed without mutation or synthetic success.
- Duplicate processing and restart/replay produce no duplicate request or route-decision event.
- Full-but-eligible pool remains pending while full, then routes once when capacity becomes free.
- Unrelated driver, peer, Direct, Nanny, and Au Pair routing behavior remains unchanged.
- D1 bridge retention/liveness and D4 peer-route reconciliation controls remain green.
- No rendered UI changed; screenshots are not required.

## Commands

```bash
cd loop-fork
bun run test:file -- tests/loop/governess.test.ts
bun run test:file -- tests/loop/utility-runtime.test.ts
bun run test:file -- tests/loop/utility-store.test.ts
bun run test:file -- tests/loop/bridge.test.ts
bun run test:file -- tests/loop/governess-p0-runtime.test.ts
bun run check
bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts
bun run build
bun run test:ci
./harness preflight --json harvto-d3-pending-route
./harness stop-gate --json harvto-d3-pending-route
```

Repo root:

```bash
scripts/verify.sh harvto-d3-pending-route harvto-d3-pending-route
```

Harness eval requires passing `dimensions[*].status`. Repo-root eval requires top-level
`verdict: "pass"`, present empty `baseline_failures`, and no truthy baseline-failure key.
