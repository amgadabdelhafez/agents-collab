# Verification: Exact Replay Release Gate

## Candidate

- Branch: `codex/exact-replay-release-gate`
- Base: `origin/main` at `aa74ee73ced6b03d153d31656bdd611be74c5be0`
- Deployment: not performed
- Independent eval: pending exact-SHA review

## Passing proof

- `bun test tests/loop/replay-release-gate.test.ts`: 14 pass, 0 fail.
- Public CLI regression creates a temporary git repository, commits the exact
  registration, verifies a passing comparison, then confirms an efficiency
  regression exits 1 with a named token-ratio failure.
- `bun run build`: pass, 71 modules bundled.
- Changed-file Biome/Ultracite configuration check: pass.
- `git diff --check`: pass.

## Broader named baseline failures

- `bun run test:ci` stops at
  `tests/loop/codex-tmux-proxy.integration.test.ts`:
  `runCli reconnects the codex tmux proxy subcommand without dropping the tui socket`
  fails while binding the freshly selected test port with `EADDRINUSE`. The
  focused test was rerun independently and reproduced the same named failure.
  This slice does not change the proxy or its test-port helper.
- Repository-wide Biome check reports 224 pre-existing formatting errors and
  one warning, overwhelmingly under historical `runs/**` artifacts. The four
  changed TypeScript files pass the same configured check.

No tolerated-failure count is used as release evidence. The independent
evaluator must bind its verdict to the final commit SHA.
