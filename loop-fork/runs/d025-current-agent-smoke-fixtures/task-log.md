# Task d025-current-agent-smoke-fixtures

## Objective

Restore the compiled launch smoke producers using current supported agents and
the current launcher kickoff evidence contract.

Regression: yes
Regression id: retired-agent-smoke-producer
Regression symptom: Required smoke exits before tmux launch because Gemini/Cursor are retired.
Regression guard: private-socket launch smoke matrix

## Verification

- `evals/smoke/active-launch-interlock.sh`: PASS. Compiled binary
  `84dbcdc47c32efa415b1542cd1294316ea1eace84ccaa5bda1f663ff8d9027fc`;
  one same-workspace winner, cold resume preserves immutable binding, distinct
  worktree allowed, two live exact-socket sessions/manifests, and every
  manifest has exactly one deterministic Claude `UserPromptSubmit` hook event.
- `evals/smoke/paste-submit-readiness.sh`: PASS. Compiled OSS/Claude session,
  exact recorded socket, ledger-only full body, one 53-byte terminal nudge,
  and complete pull delivery.
- `evals/smoke/large-prompt-launch.sh`: PASS. Current OSS/Claude launch,
  isolated manifest and socket, hash-bound bootstrap, delayed Claude readiness,
  preserved-then-cleaned timeout session, `220x60` six-pane detached layout,
  hash tamper fail-closed, and exact-socket startup failure terminalized.
- `bash -n` for all changed shell producers and fake tmux: PASS.
- `python3 -m py_compile evals/smoke/fixtures/hash-bound-tui.py`: PASS; generated
  cache removed.
- `git diff --check`: PASS.
- Independent zero-write review: PASS. Confirmed fixture-only scope, verified
  bootstrap-before-hook ordering, exactly-once resume behavior, current-agent
  mappings, exact-socket negative control, and D-014 through D-024/D-026
  compatibility.

## Scope

Fixture and smoke-producer files only. No production runtime, product lane,
modernization, or installed binary changed.
