# Verify: active paired-launch interlock

## Automated checks

```bash
cd loop-fork
bun run test:file -- tests/loop/args.test.ts
bun run test:file -- tests/loop/workspace-binding.test.ts
bun run test:file -- tests/loop/launch-reservation.test.ts
bun run test:file -- tests/loop/run-state.test.ts
bun run test:file -- tests/loop/paired-options.test.ts
bun run test:file -- tests/loop/tmux.test.ts
bun run test:file -- tests/loop.test.ts
bun run check
bun run test:ci
bun run build
../evals/smoke/active-launch-interlock.sh
cd ..
scripts/verify.sh active-launch-interlock active-launch-interlock
```

## Functional checks

| # | Check | Pass condition |
|---|---|---|
| F-01 | Workspace parsing/canonicalization | Spaced/equals forms work; missing, unrelated, and branch-invalid paths fail clearly. |
| F-02 | Same binding conflict | Active/live or unknown same-root/same-branch run rejects nonzero before side effects. |
| F-03 | Atomic concurrency | Barrier test yields one winner, one loser, one manifest, and no loser cleanup against winner. |
| F-04 | Distinct binding | Distinct roots and distinct branches both remain launchable after serialization. |
| F-05 | Lifecycle | Terminal+dead permits; live or unknown topology blocks; legacy active blocks; only one cold resume proceeds and its charter hash must match. |
| F-06 | Manifest durability | New fields round-trip, legacy manifests read, and atomic replacement never exposes partial JSON. |
| F-07 | Compiled smoke | Exact candidate launches once; identical second launch exits nonzero; one session/active manifest remains. |

## Regression guards

- Existing promptless, Markdown, positional-plan, `--worktree`, single-agent,
  and `--run-id`/`--session` behavior remains green.
- Missing relative Markdown paths stay bound to invocation cwd; alphanumeric
  active runs cannot bypass scanning; stale reclaimers and resume losers cannot
  replace or terminalize a winner.
- Large-prompt hash-bound charter transport and readiness-timeout preservation
  remain green.
- No test reads, attaches to, kills, or mutates `harvto-loop-106`.

## Eval output

`runs/active-launch-interlock/eval.json` records commands, counts, exact
candidate commit and binary hash, smoke evidence, and independent review.
