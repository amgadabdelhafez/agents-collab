# Au Pair small-code delegation verification

- A valid one- or two-file, low-risk edit with exact read context routes to Au
  Pair and never Nanny.
- Edit packets with no read context, more than two write scopes, more than four
  read scopes, missing `scoped-edit`, non-low risk, authority, protected paths,
  or write conflicts do not execute on Au Pair.
- Startup, foreground, Claude channel, and tool-schema tests require agents to
  route suitable code blocks before authoring them and to reserve write scopes.
- Guidance defines risk as operational side-effect/authority risk without
  encouraging false low-risk labels.
- Returned patches remain proposal-only and guarded apply remains full-agent
  only.
- Focused tests, `bun run check`, TypeScript, build, `bun run test:ci`,
  base-aware `git diff --check`, and
  `scripts/verify.sh au-pair-code-delegation au-pair-code-delegation` pass.
- Independent review reports no actionable safety or routing regression.
