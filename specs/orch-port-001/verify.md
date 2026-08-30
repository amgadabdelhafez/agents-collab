# Verify: Engine-neutral workflow port and SupervisorMessage lifecycle

## Automated checks

```bash
cd loop-fork
bun run test:file -- tests/loop/workflow-port.test.ts
bun run test:file -- tests/loop/supervisor-message-workflow.test.ts
bun run check
bun run build
git diff --check
```

Run `bun run test:ci` once after focused behavior is green.

## Functional checks

| # | Check | Command / assertion | Pass condition |
|---|---|---|---|
| F-01 | Port operations | workflow-port focused test | start, signal, query, cancel, inspect and idempotency pass |
| F-02 | Message happy path | supervisor-message focused test | receive, persist, route, claim, acknowledge pass |
| F-03 | Failure policy | supervisor-message focused test | retry, escalation, exhaustion and dead-letter pass |
| F-04 | Safety | supervisor-message focused test | invalid claim/cancel refusals and projection redaction pass |
| F-05 | Engine neutrality | `rg -n "@temporal|temporalio|@dbos|from ['\"]dbos" loop-fork/src/loop/{workflow-port,in-memory-workflow-port,supervisor-message-workflow,supervisor-message-coordinator}.ts` | no matches |
| F-06 | Repository regression | `bun run test:ci` | exit 0, empty named failure set |

## UI checks

Not applicable. This slice exposes a read model but changes no UI.

## Performance thresholds

No external performance claim is made by the reference adapter. Every command
must terminate synchronously except the injected delivery activity.

## Regression guards

- [ ] Existing bridge message types and runtime delivery remain unchanged.
- [ ] No Temporal or DBOS dependency is added.
- [ ] No message body or local path appears in the public projection.

## Fixture provenance

All ORCH-PORT tests are explicitly synthetic and certify only the canonical
state machine/reference adapter. Cross-engine fixtures are deferred to
`ORCH-FIXTURE-001` and may not claim Temporal or DBOS conformance yet.

## Rollback conditions

Revert if the port requires an engine-specific type, duplicate receive invokes
delivery twice, terminal state can transition, or projection contains a body or
local path.

## Eval output

Write `runs/orch-port-001/eval.json` with named functional/regression results,
commands, exact counts, and the current commit/worktree identity.
