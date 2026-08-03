# Verify: Aggressive Au Pair Routing

- An explicit bounded `utility-audit` review routes to Au Pair for either main
  agent and returns its result to that requester.
- An omitted or explicit `peer-verdict` review preserves the existing peer or
  requester route.
- Utility audits with authority, non-low risk, writes, protected paths,
  malformed metadata, missing epoch, or unavailable GLM fail closed.
- Utility audit mode on a non-review request fails closed.
- Three- or four-scope reasoning-backed inspections and non-direct commands go
  to Au Pair; one- or two-scope bounded inspections remain Nanny.
- Exact deterministic reads/checks remain Direct.
- Prompt and tool-schema tests require utility-audit and edit packets without
  allowing agents to choose a provider.
- Focused tests, check, typecheck, build, full named test suite, diff check, and
  `scripts/verify.sh aggressive-au-pair-routing aggressive-au-pair-routing`
  pass with an empty baseline allowlist.
- Independent review is bound to the exact candidate SHA before deployment.
