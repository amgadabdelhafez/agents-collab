# Tasks: Delegation Grammar Widening

1. **RED** — extend `loop-fork/tests/loop/delegation-policy.test.ts` with:
   - positive table for decomposed compounds (pipe filters, leading in-repo
     `cd` with cwd folding, trailing `2>/dev/null`, composed order);
   - positive table for `ls`/`wc -l` grammar additions;
   - negative table (arbitrary pipe targets, double pipes, non-digit counts,
     real-file redirects, out-of-repo/governed `cd`, `&&` mutation chains,
     triple `&&`, filter-blessed non-grammar base, unsupported `ls` flags,
     glob paths, `wc` variants).
   Run the file; confirm the new cases fail for grammar reasons.
2. **GREEN** — implement tokenizer refactor + `decomposeSafeCompound` +
   `classifyBash` rewiring + `classifyLs`/`classifyWc` + type additions.
   Run the file; all pass.
3. **Verify** — `bun run check`, full `bun test` (baseline: 4 known
   Codex-launch failures), `bun run build`; harness `verify unit` wrapper.
4. **Evaluate** — independent evaluator agent runs `verify.md` and authors
   `runs/delegation-grammar-widening/eval.json`; append task-log entry.
