# Verify: Web UI integrated certified stack

## Automated checks

Run from `loop-fork/` after both parents are merged:

```bash
bun run test:ci
bunx ultracite check <all changed non-run code/config paths derived from Git>
bun run build
git diff --check github/main...HEAD -- . ':(exclude)loop-fork/runs/**'
node --check loop-fork/runs/webui-integrated-stack-v1/artifacts/verify-integration.mjs
```

## Functional checks

| # | Check | Pass condition |
|---|---|---|
| F-01 | Exact parent ancestry | Both certified heads pass `git merge-base --is-ancestor` |
| F-02 | Conflict scope | Only the two declared registry paths required hand resolution |
| F-03 | Task registry union | Four component task IDs occur exactly once and JSON parses |
| F-04 | Debt registry union | Every component row is retained exactly once and each JSONL row parses |
| F-05 | Combined regression | `bun run test:ci` exits 0 with no tolerated failures |
| F-06 | Static/build | The derived changed non-run Ultracite check and `bun run build` exit 0; the failed repository-wide generated-evidence formatter receipt remains recorded |
| F-07 | Diff integrity | Non-run diff check and integration verifier syntax check exit 0; the exact four inherited T-00 log diagnostics are recorded but their reviewed bytes are unchanged |

## UI checks

No new UI behavior is introduced. Existing committed component UI evidence is
preserved, and the combined regression/build checks certify composition.

## Regression guards

- [ ] T-00 adapter identity tests still pass.
- [ ] T-01 control-surface tests still pass.
- [ ] Theme, mobile, exact-host, and tailnet tests still pass.
- [ ] No product-source file differs from its corresponding component parent.

## Rollback conditions

Do not open the replacement PR if a parent is not an ancestor, a registry row is
missing or duplicated, any unapproved file is hand edited, or any required check
fails.

## Eval output

The evaluator writes `loop-fork/runs/webui-integrated-stack-v1/eval.json` with
explicit ancestry, registry, regression, check, build, diff, and review status.
