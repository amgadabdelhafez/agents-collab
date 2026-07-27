# Independent Review: compound-worktree-observability

## Verdict

PASS. No unresolved safety, correctness, privacy, or viewport blocker remains.

## Scope reviewed

- `specs/compound-worktree-observability/{spec,plan,tasks,verify}.md`
- Compound tokenization and structured read-plan classification
- Leading-`cd` workspace hint recovery and the registered-worktree verifier
- Utility performance/context/failure aggregation
- Governess worker-detail rendering and viewport budgeting
- New routing, hook, workspace, observability, and governess regressions

## Findings and disposition

Four issues found during review were corrected before this verdict:

1. The initial implementation bounded total stages but not the specified six
   presentation labels. `MAX_READ_PLAN_LABEL_STAGES` and fail-closed counting
   now enforce the separate limit.
2. The initial tool-failure summary accepted arbitrary sanitized `error.code`
   text. It now renders only a bounded lowercase code shape; prompt-like text is
   reduced to `unknown` and is absent from the transcript and board.
3. Individually finite but extreme persisted numbers could overflow during
   aggregation, and malformed cache counts could exceed 100%. Numeric inputs
   now clamp to `Number.MAX_SAFE_INTEGER`, additions saturate, and ratios clamp
   to `[0,1]`; the regression uses two `1e308` events.
4. Compact stderr redirects immediately followed by `;` or `&&` were rejected.
   Redirect token boundaries now include safe recognized separators, while the
   downstream structure still rejects unsupported operators.

No unresolved finding remains.

## Safety and correctness evidence

### Compound parsing

- The lexer recognizes only literal words, one pipeline, `&&`, `;`, and the two
  supported stderr redirects. Raw controls, substitution, glob syntax, `||`,
  backgrounding, and arbitrary redirection still fail closed
  (`src/loop/delegation-policy.ts:514-687`).
- Every non-label segment is independently classified through the existing
  broker-backed read-only grammars; one unsupported or mutating segment rejects
  the whole candidate. Executable stages and labels have independent six-stage
  caps (`src/loop/delegation-policy.ts:1742-1844`).
- Accepted compounds persist `executionPlan` broker primitives. They are not
  passed to a shell.
- The Loop 54 replay converted only 3 of 146 prior compound rejects, all bounded
  repository source reads. The other 143 remained `compound-or-unsafe-command`.

### Registered-worktree authority

- Workspace recovery scans only the bounded prefix through the first unquoted
  `&&`; it does not tokenize or trust the remainder
  (`src/loop/delegation-policy.ts:863-915`).
- Long and substitution-bearing unsafe remainders recover the literal prefix
  only when appropriate and still reject as unsafe. Substituted and unrelated
  targets remain unverified (`tests/loop/governess-hooks.test.ts:381-502`).
- The authoritative resolver remains unchanged: a target outside the run root
  must resolve to a registered worktree with the same canonical Git common
  directory, and all normalized scopes must select one root
  (`src/loop/utility-workspace.ts:109-143`,
  `src/loop/utility-workspace.ts:166-248`).
- Real Git-fixture tests cover registered linked roots, unrelated repositories,
  mixed roots, symlink escapes, and copied `.git` pointer spoofing
  (`tests/loop/utility-workspace.test.ts:261-345`).

### Observability and privacy

- A latest-per-job usage map avoids double-counting progress records. Derived
  sums are saturating and ratios bounded
  (`src/loop/utility-observability.ts:288-297`,
  `src/loop/utility-observability.ts:343-462`).
- Context display uses counts, version, and an eight-character SHA-256 prefix;
  it never reads or renders capsule text or reference paths
  (`src/loop/utility-observability.ts:465-510`).
- Failure display accepts only bounded code-shaped metadata. Error messages and
  tool output are not rendered (`src/loop/utility-observability.ts:318-323`,
  `src/loop/utility-observability.ts:513-621`).
- Regressions cover absent/torn JSONL, huge values, cache clamping, prompt-like
  error text, secret redaction, deterministic averages, context coverage, and
  failure counts (`tests/loop/utility-observability.test.ts:18-152`,
  `tests/loop/utility-observability.test.ts:195-445`).

### Governess viewport

- Three stable rows report performance, load, and context/failures. Empty data
  uses visible defaults rather than NaN, Infinity, or blank rows
  (`src/loop/governess.ts:1977-2009`).
- Both row construction and the final ANSI-aware board pass enforce the selected
  width. Height budgeting preserves status and agent rows before optional worker
  details (`src/loop/governess.ts:3070-3137`).
- Board fixtures assert the exact metrics, metadata-only privacy, 176-column
  bounds, and a five-row viewport retaining Claude, Codex, and worker
  (`tests/loop/governess.test.ts:1850-1924`).

## Independent commands

- Focused routing/hook/workspace/observability/governess suites: **316 passed,
  0 failed**.
- Full `bun test`: **1045 passed, 4 failed**. The four failures are the known
  inherited Codex configuration expectation mismatches in
  `paired-options.test.ts` and `runner.test.ts`; this patch does not touch those
  files or their implementation paths.
- `bun run build`: passed.
- `git diff --check`: passed.
- `../scripts/verify.sh`: passed (the repository wrapper currently contains
  placeholder lint/typecheck/test sections).
- `bun run check`: still fails on the inherited repository baseline (261
  diagnostics plus one warning, predominantly historical run-artifact format
  debt and existing complexity/control-regex findings). A targeted base-branch
  check confirms the delegation-policy complexity findings predate this patch.
- Loop 54 replay: 146 old compound rejects -> 3 eligible structured read plans,
  143 still unsafe; one valid leading-worktree hint recovered; two genuinely
  external workspace cases remain unverified.

## Boundary note

This verdict covers the implementation and acceptance behavior. Installation
is a separate required Harness dimension and was intentionally not performed by
the independent evaluator.
