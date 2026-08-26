# Tasks: Web UI integrated certified stack

## Checklist

- [ ] **T-01** Record exact base, parent heads, and conflict set.
- [ ] **T-02** Merge both certified histories and retain both registry sides.
- [ ] **T-03** Verify ancestry, registry completeness, and exact edit scope.
- [ ] **T-04** Run combined tests, check, build, and diff validation.
- [ ] **T-05** Write eval, commit, push the feature branch, and open the replacement PR.

## Task detail

### T-01 through T-05

**Goal:** Produce a combined, verified branch without changing component code.
**Files:** Only task-owned spec/evidence plus the two conflict registries.
**Inputs:** The exact GitHub base and the two certified component heads from
`spec.md`.
**Output:** `loop-fork/runs/webui-integrated-stack-v1/` and a feature PR.
**Done when:**

- [ ] Both parent heads remain ancestors.
- [ ] Both registries contain the exact union without duplicate task IDs.
- [ ] Combined verification passes.
- [ ] `eval.json` exists and passes before the replacement PR opens.
