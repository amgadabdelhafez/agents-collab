# Verification

```bash
cd loop-fork
./harness verify unit -- bun test tests/loop/utility-execution-tier.test.ts
bun test tests/loop/utility-runtime.test.ts tests/loop/utility-pi-harness.test.ts
bun test
bun run build
git diff --check
cd ..
scripts/verify.sh
```

Additional live gates:

- Capture Loop 56 Claude and Codex pane IDs/PIDs before and after deployment.
- Assert one live unprofiled one-or-two-scope inspection persists
  `tierId: utility-nanny`.
- Assert its usage row contains `harness: pi-sdk`, `role: Nanny`, the local
  provider/model, and the pinned Pi version.
- Assert no Au Pair job is created for that request.
