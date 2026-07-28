# Verification

## Focused

```bash
cd loop-fork
bun test tests/loop/bridge.test.ts tests/loop/bridge-guidance.test.ts \
  tests/loop/task-router.test.ts tests/loop/utility-runtime.test.ts \
  tests/loop/utility-pi-harness.test.ts tests/loop/tmux.test.ts
bun run build
git diff --check
```

## Full

```bash
cd loop-fork
bun run test:ci
cd ..
scripts/verify.sh
```

## Acceptance replays

- Narrative or absolute `context_refs` fail immediately with corrective text
  and create no utility job.
- A repo-relative Markdown context reference is accepted.
- The two previously rejected Loop-59 audit shapes become Au Pair eligible when
  encoded through the repaired bridge contract.
- Exact read-plan metadata survives bridge parsing and remains bounded by the
  deterministic router and broker.
- Real historical malformed Au Pair calls receive actionable bounded feedback;
  existing three-round and 32-tool ceilings still stop runaway work.

## Live

- Claude and Codex PIDs are unchanged.
- Bridge MCP processes use the new binary/schema.
- Governess, Nanny, Au Pair, routes, tools, and results panes remain live.
- A read-only canary becomes a Nanny, Au Pair, or Direct job, reaches a terminal
  state, and is delivered to its named requester.
