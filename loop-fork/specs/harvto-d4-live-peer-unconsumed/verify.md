# D4 Live Peer Unconsumed Verification

## Acceptance checks

- Named regression fails unchanged base because exact live-peer routed work lacks bounded durable
  consumption or terminal transition, or exact contrary proof shows the invariant already holds.
- Exact target and positive liveness are proven independently from notification and delivery.
- Durable journal sequence distinguishes route, bridge append/delivery, peer consumption,
  correlated response, and terminal utility state.
- Live target reaches consumption/terminal result within deterministic bounded reconciliation.
- Dead and unknown target cases fail closed without synthetic success or silent loss.
- Duplicate wake/reconciliation and duplicate response produce one effective dispatch and one
  terminal resolution.
- Restart/replay resumes pending routed work without duplicate dispatch or completion.
- Unrelated target remains untouched; routed-driver/requester/utility controls remain green.
- D1 liveness, retention, backpressure, ordering, dedupe, acknowledgement, and compatibility tests
  remain green.
- No rendered UI changed; screenshots are not required.

## Commands

```bash
cd loop-fork
bun run test:file -- tests/loop/utility-runtime.test.ts
bun run test:file -- tests/loop/bridge.test.ts
bun run test:file -- tests/loop/governess-p0-runtime.test.ts
bun run test:file -- tests/loop/utility-store.test.ts
bun run check
bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts
bun run build
bun run test:ci
./harness preflight --json harvto-d4-live-peer-unconsumed
./harness stop-gate --json harvto-d4-live-peer-unconsumed
```

Repo root:

```bash
scripts/verify.sh harvto-d4-live-peer-unconsumed harvto-d4-live-peer-unconsumed
```

Harness eval must contain `required` and passing `dimensions[*].status`. Repo-root eval must have
top-level `verdict: "pass"`, present empty `baseline_failures`, and no truthy baseline-failure key.
