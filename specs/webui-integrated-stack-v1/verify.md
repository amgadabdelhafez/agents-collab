# Verify: Web UI integrated certified stack

## Automated checks

Run from `loop-fork/` after both parents are merged:

```bash
bun run test:ci
bun run check
bun run build
git diff --check github/main...HEAD
```

## Functional checks

| # | Check | Pass condition |
|---|---|---|
| F-01 | Exact parent ancestry | Both certified heads pass `git merge-base --is-ancestor` |
| F-02 | Conflict scope | Only the two declared registry paths required hand resolution |
| F-03 | Task registry union | Four component task IDs occur exactly once and JSON parses |
| F-04 | Debt registry union | Every component row is retained exactly once and each JSONL row parses |
| F-05 | Combined regression | `bun run test:ci` exits 0 with no tolerated failures |
| F-06 | Static/build | `bun run check` and `bun run build` exit 0 |
| F-07 | Diff integrity | `git diff --check github/main...HEAD` exits 0 |

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
