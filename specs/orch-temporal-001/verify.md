# Verify: Temporal WorkflowPort adapter

## Focused gate

```bash
cd loop-fork
bun run test:file -- tests/loop/temporal-workflow-port.test.ts
```

The Bun test invokes the Temporal SDK in a supported Node process when native
worker execution requires it. Required: unchanged six-case corpus PASS,
aggregate digest
`5f1bd79af5217d60339a50996d6f3bc04c6f745e9a0c2a832d09cfe0caf8abdd`,
zero failures, and safe teardown.

## Full/static gates

```bash
cd loop-fork
bun run test:ci
bun run check
bun run build
git diff --check
```

Also require a source scan proving Temporal imports occur only in the adapter,
Temporal workflow, and Temporal replay runtime/test files, never canonical
WorkflowPort, SupervisorMessage, or fixture modules.
