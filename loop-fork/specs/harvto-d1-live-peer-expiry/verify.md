# D1 Live Peer Expiry Verification

## Acceptance checks

- Named baseline regression fails unpatched code because live-target TTL writes `expired` and live
  queue pressure writes `dead-letter`.
- Live and unknown messages remain pending after TTL and first pressure overflow.
- Confirmed-dead TTL writes exactly one `expired`; confirmed-dead pressure writes exactly one
  `dead-letter`.
- Later live-to-dead transition terminalizes once.
- At `maxRetained`, net-new enqueue returns `backpressure` without message/transcript acceptance,
  and formatter output reports backpressure rather than queued success.
- Whole-server-down, session-dead, and session-unknown pane probes classify target unknown and
  terminalize nothing.
- Superseding a same-dedupe identity remains admitted at ceiling.
- Three or more separate pending reconstructions followed by two consumes yield one effective
  delivery and one terminal resolution.
- Pre-fix message lines parse in fixed code; fixed optional metadata remains parseable when unknown
  fields are ignored.
- Priority, dedupe, supersession, acknowledgement, ordering, status, and queue health controls pass.
- No rendered UI changed; screenshots not required.

## Commands

```bash
cd loop-fork
bun run test:file -- tests/loop/governess-p0-runtime.test.ts
bun run test:file -- tests/loop/bridge.test.ts
bun run check
bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts
bun run build
bun run test:ci
```

Expected complete suite: all 77 `tests/**/*.test.ts` files pass serially under
`LOOP_TEST_CERTIFICATION_MODE=single-file`.

Repo root:

```bash
scripts/verify.sh harvto-d1-live-peer-expiry harvto-d1-live-peer-expiry
```

`runs/harvto-d1-live-peer-expiry/eval.json` must have top-level `verdict: "pass"`, present empty
`baseline_failures`, and no truthy baseline-failure key. Harness `preflight` and `stop-gate` must pass.
