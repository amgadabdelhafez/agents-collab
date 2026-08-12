# Verification

## Focused proof

The implementation must name every new regression test in the defect matrix and show that it fails against the unpatched baseline or otherwise demonstrates a missing invariant.

Required cases for confirmed defects:

- delivery to a live peer after transient bridge failure, with no duplicate and no silent expiry;
- exact manifest target absent/dead while stale process or prose evidence exists;
- no eligible utility worker at route time and after bounded retry/recovery;
- completion without prior close signal, including durable restart/replay behavior;
- stale lease attempting a write after authority changes;
- handoff preservation of model, effort, workspace, and run identity.

## Mandatory suites

```bash
bun run check
bun test
bun run build
```

Harness must record the mandatory suites. A green focused subset is not campaign completion.

## Review

The peer reviewer must perform a zero-write review of the exact implementation SHA and report `PASS` or actionable findings. Any correction creates a new SHA and requires a fresh exact-SHA verdict.
