# Verify: Handover Effort Fidelity and Governess Restart Reconciliation

## Focused checks

```bash
cd loop-fork
bun run test:file -- tests/loop/governess-runtime.test.ts
bun run test:file -- tests/loop/governess-exit.test.ts
bun run test:file -- tests/loop/governess.test.ts
```

The handover regressions must prove the manifest binds `driverEffort`,
`reviewerEffort`, both bundles, and the continuation file; replacement argv
must contain the exact frozen values; and any bound-file mutation must make the
manifest unreadable.

The renderer regression must start with a stale predecessor frame, apply the
production initial-frame output, and prove that the resulting visible/history
model contains exactly one current agent row and one current helper row with no
predecessor row retained. It must also prove steady-state frame deltas do not
clear the screen.

## Project gate

```bash
scripts/verify.sh handover-fidelity-dedup handover-fidelity-dedup
```

The exact candidate commit must receive stamped supervisor review. No install,
deployment, or live-run mutation is authorized by this task.
