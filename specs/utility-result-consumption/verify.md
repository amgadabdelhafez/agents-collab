# Verify: Utility Result Consumption

```bash
cd loop-fork
bun test tests/loop/bridge.test.ts
bun run build
cd ..
scripts/verify.sh
git diff --check
```

The focused regression must materialize the same durable job plus queued
handover produced in a live run, retrieve the result, and prove only the exact
unclaimed handover becomes delivered.

The supervisor regression must prove all three states: the supervisor receives
the completed result, the requester handover remains pending with no delivered
event, and the requester can subsequently drain that exact handover. Mutating
the supervisor exemption to enter the requester-only consumption path must fail
this regression.
