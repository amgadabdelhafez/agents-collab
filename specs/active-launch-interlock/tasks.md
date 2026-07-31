# Tasks: active paired-launch interlock

## Checklist

- [x] **T-01 Workspace contract** — Parse and validate `--workspace`, enter the canonical registered worktree before task resolution, and preserve relative Markdown prompt paths.
- [x] **T-02 Durable reservation** — Persist immutable workspace/claim fields, atomically write manifests, and reserve numeric run directories exclusively.
- [x] **T-03 Single-flight gate** — Reject live, unknown, legacy, same-root, or same-branch conflicts before any task/agent side effect; serialize cold resumes with attempt claims.
- [x] **T-04 Owned cleanup** — Ensure a failed launcher only kills a tmux session it positively created.
- [x] **T-05 Regression proof** — Add focused, barrier-concurrency, cold-resume, stale-lock, CLI ordering, manifest round-trip, and compiled-smoke coverage.
- [ ] **T-06 Release gate** — Run full verification, record `runs/active-launch-interlock/eval.json`, obtain independent exact-SHA review, and announce any deployment.
