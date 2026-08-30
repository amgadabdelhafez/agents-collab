# Verify: DBOS WorkflowPort adapter

## Focused gate

```bash
cd loop-fork
bun run test:file -- tests/loop/dbos-workflow-port.test.ts
```

Required: a real DBOS runtime backed by isolated PostgreSQL and the unchanged
six-case corpus. The first five cases must match exact frozen digests. The
sixth must either complete the exact aggregate digest
`5f1bd79af5217d60339a50996d6f3bc04c6f745e9a0c2a832d09cfe0caf8abdd`
or positively prove DBOS's prior-version recovery refusal using persisted
workflow status/version, current runtime version, bounded timeout, and clean
teardown. A same-version relaunch cannot satisfy the upgrade case.

## Full/static gates

```bash
cd loop-fork
bun run test:ci
bun run check
bun run build
git diff --check
```

Also require a source scan proving DBOS imports occur only in the DBOS adapter,
workflow, replay runtime, and focused test, never canonical or fixture modules.
