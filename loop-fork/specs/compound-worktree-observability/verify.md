# Verification

## Routing

- A repository-only `sed ...; echo ...; grep ... | head` candidate becomes a
  structured read plan whose executable stages all use broker primitives.
- Mixed `&&` and `;` separators preserve ordered executable stages.
- Mutation, substitution, heredocs, external scopes, empty stages, `||`, and
  unsupported pipelines reject the whole candidate.

## Worktrees

- An external hook cwd with `cd <registered-worktree> && <safe reads>` routes
  against the registered worktree.
- The same prefix followed by mutation is classified unsafe rather than
  workspace-unverified.
- Unrelated, missing, and substituted targets remain workspace-unverified.

## Worker detail

- Fixture artifacts render deterministic performance, load, context, and
  failure rows.
- Empty and malformed artifacts render zero/default values without NaN,
  Infinity, blank-row flicker, prompt text, or instruction content.
- Rendered lines remain within the selected terminal width. A plain terminal
  capture is the terminal-UI equivalent of a DOM assertion; browser DOM is not
  applicable.

## Commands

```bash
bun test tests/loop/delegation-policy.test.ts tests/loop/governess-hooks.test.ts
bun test tests/loop/utility-workspace.test.ts tests/loop/utility-observability.test.ts tests/loop/governess.test.ts
bun test
bun run build
bun run check
git diff --check
../scripts/verify.sh
```

## Acceptance

- All new focused tests pass.
- Full tests and build pass, apart from explicitly documented inherited
  baseline failures.
- Independent evaluator reports no blocking safety or correctness issue.
- Installation is atomic and does not restart active Claude or Codex panes.

