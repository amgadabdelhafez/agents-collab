# D1 Live Peer Expiry Plan

## Approach

1. Reproduce unpatched TTL and queue-depth terminalization with injected clock and live-target
   callback. Record exact journal events before production changes.
2. Add an injectable bounded pane probe in `tmux-control.ts` and a lazy, per-target memoized resolver
   at the bridge-store boundary. Default evidence uses exact manifest pane/process probes; tests
   inject `live|dead|unknown` directly.
3. Thread the resolver through enqueue's transitive pending read. Resolve only when TTL elapsed, a
   pressure marker needs confirmed-dead handling, or enqueue reaches queue pressure.
4. Keep duplicate and supersede logic first. Apply retained ceiling only to net-new count.
5. Persist queue pressure as optional message metadata, return `backpressure` before journal
   acceptance at ceiling, and format that non-resolution status explicitly.
6. Prove live/unknown retention, confirmed-dead controls, ceiling, later-dead terminalization,
   supersession at ceiling, journal compatibility, and no duplicate delivery/resolution.
7. Verify focused files, lint, explicit typecheck, build, all 77 serial test files, repo-root eval,
   `scripts/verify.sh`, Harness preflight, and Harness stop-gate.
8. Prove D1-only diff, commit explicit paths, and request Claude zero-write review of exact SHA.

## Files

- Production: `src/loop/tmux-control.ts`, `src/loop/bridge-store.ts`, and
  `src/loop/bridge-dispatch.ts`, plus the existing result narrowing in `src/loop/governess.ts`.
- Tests: `tests/loop/governess-p0-runtime.test.ts`; `tests/loop/bridge.test.ts` only for affected
  exact formatter/runtime controls.
- Evidence: D1 spec/run artifacts, repo-root eval, `PLAN.md`, `status.md`, D1 defect-matrix section.

## Rejected designs

- Treating session existence, route configuration, notification, or heartbeat as live peer proof.
- Treating missing/unknown evidence as dead.
- Treating a nonzero pane-probe command exit as authoritative pane death.
- Unlimited live/unknown queue growth.
- Dropping or superseding old work solely to admit a higher-priority pressure message.
- New terminal or pressure event variant that old readers may not recognize.
- Eager liveness probes on every status or pending read.
