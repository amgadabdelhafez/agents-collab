# D15 close evidence

- Task: `harvto-d15-teardown-process-orphans`
- Implementation SHA: `5f5ddba66cdb1bc5d8f6212b763323f507b0b777`
- Exact-SHA zero-write PASS: `b5280c18-08cc-439c-8009-9d121ea1dfe8`
- Close command: `./harness done harvto-d15-teardown-process-orphans`
- Attempts: exactly 1
- Exit: 0
- Ended: `2026-08-16T06:56:26Z`

## Positive proof

- Pre-close snapshot: `pre-close-lifecycle.json`, SHA-256
  `66666865793bc34d117e7f5a82d03e10b5482aa454dbe79bce8fb697f81e9d7e`.
- Post-close snapshot: `post-close-lifecycle.json`, SHA-256
  `fb0b63c017dea91d60fad622242b0fd7bd3f9eab14ce2fa48c23afdb41ba7a71`.
- D15 terminal record count: 0 before, exactly 1 after.
- Total Harness task record count: 61 before, 61 after.
- Lifecycle-scope D15 terminal records: 0 before, exactly 1 after.
- Harness status: exit 0, `active_task: null` after close.
- Lifecycle deltas: `.harness/current-task` removed; `.harness/tasks.json` changed from SHA-256
  `146b4780ef39ba72e151712de076ca119c01aeef706abc0d8b7f116c225519cd` to
  `cef409131389c1eec8513a509724a33915356dde080dcdffea4e9321c3ba15a8`; all other inventoried
  lifecycle files remained byte-identical.
- Git HEAD stayed `5f5ddba66cdb1bc5d8f6212b763323f507b0b777`; index stayed empty through close.
- No path under `loop-fork/src/` or `loop-fork/tests/` changed during close.
- Root `.loop/` remained untracked with 60 files; utility remained `0/off/0`.

## Portability bound

Both post-close `git check-ignore -v` calls resolve only to `loop-fork/.gitignore:3:PLAN.md`, and
`git config --get core.ignorecase` returns `true`. Uppercase `PLAN.md` in
`loop-fork/.gitignore:3` matches lowercase `plan.md` on the current case-insensitive macOS
filesystem; a case-sensitive filesystem fails the force-add precheck closed. Only these two paths
are authorized for `git add -f`:

- `loop-fork/runs/harvto-d15-teardown-process-orphans/plan.md`
- `loop-fork/specs/harvto-d15-teardown-process-orphans/plan.md`

## Bookkeeping staged-set proof

The first pre-staging shell invocation exited before any `git add` because its loop variable
shadowed zsh's special `path` parameter. The index was re-proved empty and HEAD unchanged before the
corrected explicit-path invocation.

- Quoted array duplicate check: pass.
- Expected path count: 34, non-zero.
- Pathspec-filtered cached count: 34.
- Unfiltered cached count: 34.
- Sorted expected versus filtered actual set: exact match.
- Sorted expected versus unfiltered actual set: exact match.
- Root `.loop/` exclusion: pass.
- `loop-fork/src/` exclusion: pass.
- `loop-fork/tests/` exclusion: pass.
- Force-add count: exactly 2, limited to the two ignore-verified plans above.

Exact staged set:

```text
PLAN.md
loop-fork/.harness/parked-ideas.jsonl
loop-fork/.harness/tasks.json
loop-fork/agents/coordination.jsonl
loop-fork/debt/register.jsonl
loop-fork/runs/harvto-d15-teardown-process-orphans/artifacts/close/post-close-lifecycle.json
loop-fork/runs/harvto-d15-teardown-process-orphans/artifacts/close/pre-close-lifecycle.json
loop-fork/runs/harvto-d15-teardown-process-orphans/artifacts/close/summary.md
loop-fork/runs/harvto-d15-teardown-process-orphans/artifacts/debt/baseline-loc.json
loop-fork/runs/harvto-d15-teardown-process-orphans/artifacts/debt/scan.json
loop-fork/runs/harvto-d15-teardown-process-orphans/artifacts/debt/scan.log
loop-fork/runs/harvto-d15-teardown-process-orphans/artifacts/post-task/10-current-task.sh.log
loop-fork/runs/harvto-d15-teardown-process-orphans/artifacts/post-task/state-invariants.jsonl
loop-fork/runs/harvto-d15-teardown-process-orphans/artifacts/post-task/state-invariants.log
loop-fork/runs/harvto-d15-teardown-process-orphans/artifacts/pre-task/10-current-task.sh.log
loop-fork/runs/harvto-d15-teardown-process-orphans/artifacts/pre-task/state-invariants.jsonl
loop-fork/runs/harvto-d15-teardown-process-orphans/artifacts/pre-task/state-invariants.log
loop-fork/runs/harvto-d15-teardown-process-orphans/artifacts/red/reproduction.md
loop-fork/runs/harvto-d15-teardown-process-orphans/artifacts/regression-harvest/harvest.json
loop-fork/runs/harvto-d15-teardown-process-orphans/eval.json
loop-fork/runs/harvto-d15-teardown-process-orphans/memory/001-initial.md
loop-fork/runs/harvto-d15-teardown-process-orphans/memory/002-promoted-parked-idea.md
loop-fork/runs/harvto-d15-teardown-process-orphans/meta.json
loop-fork/runs/harvto-d15-teardown-process-orphans/parked-idea.md
loop-fork/runs/harvto-d15-teardown-process-orphans/plan.md
loop-fork/runs/harvto-d15-teardown-process-orphans/task-log.md
loop-fork/runs/harvto-supervisor-defects/artifacts/defect-matrix.md
loop-fork/specs/harvto-d15-teardown-process-orphans.md
loop-fork/specs/harvto-d15-teardown-process-orphans/plan.md
loop-fork/specs/harvto-d15-teardown-process-orphans/spec.md
loop-fork/specs/harvto-d15-teardown-process-orphans/tasks.md
loop-fork/specs/harvto-d15-teardown-process-orphans/verify.md
runs/harvto-d15-teardown-process-orphans/eval.json
status.md
```

## Cached diff acceptance

- Cached content review: pass. Changes are limited to D15 lifecycle, contracts, evidence, matrix,
  debt indicators, coordination, and root plan/status bookkeeping.
- Staged JSON and JSONL parsing: pass.
- `git diff --cached --check`: pass.
- Normal cached numstat row count: 34.
- `--ignore-all-space` cached numstat row count: 34.
- Normal and `--ignore-all-space` cached numstats: exact match.
- No staged path starts with `.loop/` or lies under `loop-fork/src/` or `loop-fork/tests/`.
