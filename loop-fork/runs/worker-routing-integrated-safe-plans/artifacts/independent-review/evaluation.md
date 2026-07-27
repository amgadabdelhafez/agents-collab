# Independent evaluation: integrated safe worker routing

Evaluator: `runaway_guard_evaluator`  
Date: 2026-07-27  
Verdict: **PASS**

## Blocking findings

None in the current code boundary.

## Authority-boundary review

- The fixed `read-plan` profile exposes no tools by itself. Production creates a
  structured broker whose visible definition is only the current stage's one
  tool, and advances only after that stage returns a successful broker result.
  `assertComplete()` rejects prose completion before every stage succeeds.
- Each stage retains its own `readScope`, exact `executionRead` slice, and
  `executionOutput` boundary. The production `runUtilityWorker` path selects
  this broker for `executionProfile: "read-plan"`; it does not fall back to the
  old fixed-profile tool set.
- Request validation checks the structured plan shape and exact union of
  persisted scopes. Repository-wide Git metadata stages require the explicit
  scope `["."]`; `createUtilityReadPlanBroker` independently enforces the same
  rule, so persisted-request tampering fails closed at both boundaries.
- Linked-worktree resolution normalizes every structured stage and preserves
  each stage's exact read and output limits before the runtime sees it.

## Independent escape replays

The original narrow automatic request was replayed from classification through
the production broker:

- `cat src/loop/agents.ts` persists one `file-read` stage.
- Only `read_file` is visible for that stage.
- `git_inspect show-stat HEAD` returns `tool_denied`.
- The valid exact `read_file` call succeeds and completes the plan.

The previously forged request was also replayed with a `git-inspect` stage but
the false narrow scope `["src/loop/agents.ts"]`:

- `routeUtilityRequest` returns `request-not-bounded` and keeps it with the
  driver.
- Direct broker construction throws `structured git-inspect requires explicit
  repository scope`.
- No Git command executes and no unrelated repository paths are returned.

## Regression coverage reviewed

- Cat-only plans cannot invoke Git tools.
- Multi-directory list plans cannot read file contents or cross stage order.
- Mixed plans preserve exact source slices and head/tail output filters.
- Final completion is rejected until all structured stages succeed.
- Linked-worktree normalization preserves every stage boundary.
- The literal shell grammar continues to reject unsafe separators, redirects,
  substitutions, variables, globs, interpreters, network/mutation/process
  commands, malformed stages, and oversized plans.
- Four-slot concurrency, contention-safe claims, the three-denial breaker,
  third-identical-call breaker, 64-model-call ceiling, and runtime reaper remain
  integrated.

## Verification run

- Nine focused boundary suites: **435 passed, 0 failed**.
- Full suite: **1024 passed, 4 failed**. The four failures are the known
  pre-existing stale Codex-default expectations in untouched paired-options and
  runner tests; none exercises this change.
- `bun run build`: **passed**.
- `git diff --check`: **passed**.
- Independent automatic and forged production-boundary replays: **passed**.

## Scope note

This verdict covers the independent diff, request-validation, broker/runtime,
workspace, and regression review. Live loop-53 restart/layout acceptance was
not re-run because its tmux server disappeared; that external runtime check
must remain a separate pending/blocked Harness dimension until a live session
exists.

## Final verdict

**PASS** — the structured per-stage broker now enforces least authority and the
original plus forged narrow-scope Git escapes fail closed. No blocking code
finding remains for the independent-review dimension.
