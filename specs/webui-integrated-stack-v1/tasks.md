# Tasks: Web UI integrated certified stack

## Checklist

- [x] **T-01** Record exact base, parent heads, and conflict set.
- [x] **T-02** Merge both certified histories and retain both registry sides.
- [x] **T-03** Verify ancestry, registry completeness, and exact edit scope.
- [x] **T-04** Run combined tests, scoped static checks, build, and scoped diff validation.
- [ ] **T-05** Write eval, commit, push the feature branch, and open the replacement PR.

## Task detail

### T-01 through T-05

**Goal:** Produce a combined, verified branch without changing component code.
**Files:** Only task-owned spec/evidence plus the two conflict registries.
**Inputs:** The exact GitHub base and the two certified component heads from
`spec.md`.
**Output:** `loop-fork/runs/webui-integrated-stack-v1/` and a feature PR.
**Done when:**

- [x] Both parent heads remain ancestors.
- [x] Both registries contain the exact union without duplicate task IDs.
- [x] Combined verification passes.
- [x] `eval.json` exists and passes before the replacement PR opens.
