# Verify: Utility Task Admission

## Automated checks

```bash
cd loop-fork
bun test tests/loop/task-router.test.ts tests/loop/bridge.test.ts tests/loop/bridge-guidance.test.ts
bun run test:ci
bun run check
bun run build
```

## Functional checks

| # | Check | Assertion | Pass condition |
|---|---|---|---|
| F-01 | Separable admission | Pure router fixture | `utility-eligible` when every existing gate passes |
| F-02 | Sequential fail-closed | Pure router fixture | Driver with `work-not-separable` |
| F-03 | Unknown and legacy fail-closed | Pure router fixture | Driver with `work-not-separable` |
| F-04 | Public producer contract | Real bridge MCP `route_task` | Missing/invalid `work_shape` rejected; valid value persisted |
| F-05 | Trusted hook producer | Delegation classification fixture | Request explicitly contains `workShape: separable` |
| F-06 | Existing gates | Router regression suite | No existing route reason changes identity |
| F-07 | Guidance | Guidance fixture | Separability and sequential-work warning are present |

## UI checks

Not applicable. No UI or layout is changed.

## Regression guards

- Review remains peer/requester routed.
- Authority and forbidden authority continue to escalate.
- Missing epoch, unsafe scope, conflicts, unavailable tiers, and non-low risk
  remain fail-closed.
- Existing durable journals remain readable and cannot gain utility eligibility
  from a missing field.

## Eval output

The independent evaluator writes `runs/utility-task-admission/eval.json` with
the commands, exact commit SHA, named failures if any, and verdict `pass` or
`fail`.
