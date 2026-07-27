# Integration verification

- Focused command: `bun test` over the 13 lower-agent, bridge, proxy,
  governess, state, argument, and tmux suites selected by the Harness verifier.
- Result: 331 passed, 0 failed, 1,131 expectations.
- Full command: `bun test`.
- Result: 681 passed, 4 failed, 685 total.
- The four failures are the already-isolated default-model expectation drift:
  one paired-options assertion expects `gpt-5.5` while runtime uses
  `gpt-5.6-sol`, and three runner-config assertions encode the older default.
- Build command: `bun run build`.
- Build result: pass.
- Candidate SHA-256:
  `08b5859c414fcfcdb61aeceb24b0f87d4c7f8f150508f4e8366eb6a2da9d34ae`.
- `git diff --check`: pass.
- Exact credential-content scan: clean.

The focused result is the integration regression gate. The full-suite failures
are unrelated baseline assertions and are recorded rather than silently
discarded.
