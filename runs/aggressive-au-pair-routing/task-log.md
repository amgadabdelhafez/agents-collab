# Task log: Aggressive Au Pair Routing

## Live diagnosis

- Run: `harvto-loop-118`
- Positive liveness: all eight tmux panes alive.
- Requests: six `inspect`, three `review`.
- Routes: Direct four, Nanny two, requester three, Au Pair zero.
- All three reviews were stopped by `review-stays-with-requester` before tier
  classification.
- Au Pair configuration key exists with mode 0600; run 115 records a completed
  GLM Au Pair job, so provider outage was falsified.

## Implementation

- Added explicit persisted `utility-audit` and `peer-verdict` review modes.
- Preserved omitted review mode as the existing main-agent peer route.
- Made bounded authority-free utility audits Au Pair-only and included them in
  verified workspace adoption.
- Narrowed profiled Nanny work to inspection-only, two read scopes, and at most
  two reasoning stages. Larger reasoning work and non-direct commands now
  select Au Pair.
- Strengthened main-agent and route-tool guidance for pre-authoring edit
  packets, utility audits, commit-bound brokered Git diffs, and final
  main-agent ownership.

## Verification

- Router: 77 pass, 0 fail, 97 assertions.
- Tier classification: 11 pass, 0 fail, 26 assertions.
- Utility runtime: 51 pass, 0 fail, 234 assertions.
- Bridge integration: 92 pass, 0 fail, 385 assertions.
- Guidance: 7 pass, 0 fail, 49 assertions.
- `bun run check`: 738 files checked, no fixes.
- `bun run build`: compiled 3043 modules.
- `npm run test:ci`: every sorted test file passed, exit 0.
- `scripts/verify.sh aggressive-au-pair-routing aggressive-au-pair-routing`:
  exit 0; lint, build, full suite, and empty named baseline allowlist passed.
