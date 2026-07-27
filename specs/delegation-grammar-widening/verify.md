# Verify: Delegation Grammar Widening

```bash
cd loop-fork
bun test tests/loop/delegation-policy.test.ts \
  tests/loop/governess-hooks.test.ts \
  tests/loop/codex-tmux-proxy.test.ts
bun test
bun run check
bun run build
git diff --check
```

Pass condition:

- The focused suites are fully green.
- The full suite's only failures are the 4 known baseline Codex-launch
  failures (paired-options / runner Codex model-config expectations).
- Every acceptance criterion in `spec.md` maps to at least one assertion in
  `tests/loop/delegation-policy.test.ts` (positive shapes eligible with exact
  operation + root-relative readScope; negative shapes ineligible with exact
  reason).
- No existing reason/operation string was renamed
  (`rg -n '"(compound-or-unsafe-command|command-not-in-delegation-grammar)"' src/loop/delegation-policy.ts`
  still matches).
