# Tasks: Governess pane liveness

## Checklist

- [x] **T-01** Implement the fail-closed Governess pane-death helper and durable
      rolling restart budget.
- [x] **T-02** Dispatch the helper before CLI startup maintenance and arm a
      pane-scoped hook for newly created Governess panes.
- [x] **T-03** Make dead panes visibly stopped without changing live labels.
- [x] **T-04** Add focused unit and isolated tmux lifecycle tests.
- [x] **T-05** Run full verification and record an empty baseline-failure list.
- [x] **T-06** Obtain exact-SHA independent CONCUR and deploy only that binary.

## Deliverables

- Source and tests under `loop-fork/src/loop/` and `loop-fork/tests/loop/`.
- `runs/governess-pane-liveness/` task log, checkpoints, and `eval.json`.
- Exact commit and binary SHA-256 in the deployment evidence.
