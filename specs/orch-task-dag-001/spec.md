# Spec: canonical task dependency DAG

## Objective

Make task decomposition and dependency readiness executable workflow state.
Neither Markdown, an unvalidated database row, nor a supervisor assertion can
make a task runnable.

## Canonical node contract

Each bounded node carries a stable task ID, owner repository, content-addressed
spec artifact, sorted predecessor IDs, bounded repository-relative read and
write scopes, sorted authority-gate IDs, and sorted structured acceptance-check
IDs and kinds. Completion supplies one content-addressed receipt for every
declared check.

## Graph gates

- Reject unknown, duplicate, self, and cyclic dependency edges.
- Reject unsafe paths, unsorted canonical arrays, missing acceptance checks,
  or unbounded graph dimensions.
- Within one owner repository, overlapping write scopes require a transitive
  dependency order. Unordered overlapping writers invalidate the whole graph.
- A node becomes ready only when all predecessors succeeded and every declared
  authority gate has a content-addressed receipt.
- Claim/start require ready state and stable worker identity.
- Completion requires running ownership and the exact declared acceptance
  receipt set. Missing, extra, duplicate, or mismatched receipts refuse.
- Failure blocks every transitive descendant but permits independent branches
  to finish. The graph becomes terminal only when all nodes are terminal.
- Projection exposes deterministic ready IDs and explicit dependency/gate
  blockers.

## Temporal

The accepted Temporal workflow host must dispatch both the existing
SupervisorMessage definition and this task-graph definition without leaking
Temporal types into either canonical workflow.

