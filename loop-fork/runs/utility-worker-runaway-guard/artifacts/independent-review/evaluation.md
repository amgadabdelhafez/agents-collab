# Independent evaluation: utility worker runaway guard

Evaluator: `runaway_guard_evaluator`
Date: 2026-07-27
Verdict: **PASS**

## Scope reviewed

- `specs/utility-worker-runaway-guard/{spec,plan,tasks,verify}.md`
- Complete diff from `HEAD`, especially `src/loop/utility-runtime.ts` and
  `tests/loop/utility-runtime.test.ts`
- Failure persistence through usage JSONL, utility-job transition, tool-event
  JSONL, and requester bridge escalation
- Final wording-only correction to the emergency-ceiling comment

## Checks run

- `bun test tests/loop/utility-runtime.test.ts tests/loop/utility-store.test.ts`
  - PASS: 40 tests, 0 failures, 147 assertions
- `bun run build`
  - PASS: compiled executable successfully
- `git diff --check`
  - PASS
- `bun test`
  - 894 tests passed and 4 tests failed on pre-existing hard-coded Codex
    default expectations outside this diff
- `bun run check`
  - Not runnable in this isolated worktree because local dependencies are not
    installed (`ultracite: command not found`); this is an environment setup
    limitation, not a finding against the changed code

## Findings

1. Three consecutive `result.ok === false` broker results fail the job. Only a
   broker success resets the rejection counter. The failure includes the
   threshold and last safe broker error code.
2. The tool-name plus raw-argument-JSON fingerprint is evaluated before broker
   execution, so the third consecutive identical call produces no third tool
   event.
3. The emergency ceiling is checked before each provider invocation. After 64
   completed provider calls the job fails before call 65.
4. No token or dollar limit was added to runtime configuration or completion
   policy. The existing high-token/high-cost fixture still completes.
5. Failure usage, tool events, terminal job state, blocker text, and requester
   escalation are persisted. Tests cover the rejection threshold, reset on
   broker success, pre-execution identical-call breaker, and call-65 boundary.
6. The revised comment accurately describes the 64-call ceiling as an
   emergency fuse while retaining the governess runtime reaper as the final
   wall-time boundary. Runtime behavior is unchanged by that wording edit.

## Full-suite baseline assessment

The four full-suite failures are in untouched Codex launch/default expectation
tests and reproduce the known mismatch between stale expected defaults and the
currently committed runtime defaults. They do not block acceptance of this
runaway-guard patch. Mechanically updating those expectations should remain a
separate task so this safety fix does not absorb unrelated Codex configuration
scope.

## Final verdict

**PASS** — the implementation satisfies the runaway-prevention spec and has
focused regression coverage for every required breaker transition.
