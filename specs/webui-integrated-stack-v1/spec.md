# Spec: Web UI integrated certified stack

## Problem

The certified T-00/T-01 stack and the certified theme/mobile/tailnet stack are
individually mergeable against GitHub `main`, but both append to the Harness
task registry and debt register. Merging either first leaves the other with two
content conflicts and no combined verification receipt.

## Goal

Produce one reviewable feature branch containing both certified histories, an
additive resolution of the two registry conflicts, and fresh combined evidence.

## Non-goals

- No product, test, runtime, dependency, or generated evidence edits.
- No mutation of either certified component branch.
- No direct merge or push to `main`.
- No T-02 server implementation.

## Background

- GitHub base: `2848c91e96d1d1d57a1b0b87caea54adc6d134a6`
- T-00/T-01 evidence head: `0687932713aa59452d65a7d85e7751981c6de64d`
- Theme/mobile/tailnet evidence head: `6c9598b550354cb91fbc10887ab7549d47b8169e`
- Conflicting paths: `loop-fork/.harness/tasks.json` and
  `loop-fork/debt/register.jsonl`

## User journeys

1. A reviewer can inspect one PR containing all completed Web UI work.
2. The Harness registry retains all four completed task records.
3. The debt register retains every indicator from both component histories.
4. Combined tests fail closed if the independently certified features interact.

## Acceptance criteria

- [ ] Both exact component heads are ancestors of the integration head.
- [ ] The only hand-resolved files are the two declared registries.
- [ ] Every task and debt row from both parents is preserved exactly once.
- [ ] JSON/JSONL syntax, full regression, build, check, and diff checks pass.
- [ ] A task-scoped `eval.json` records a pass before a replacement PR opens.
- [ ] Neither component branch nor GitHub `main` is mutated.

## Out-of-scope risks

The component PRs remain independently reviewable. The integration task must
not rewrite their commits or claim a new review of their product code.

## Open questions

None. The conflict set and allowed resolution paths are exact.
