# Utility-first native fallback verification

- Governed tmux default mode is `utility-first`; unknown mode is `strict`;
  legacy non-tmux pairing and explicit `off` remain outside this policy.
- Codex config disables native agents in utility-first and strict because 0.145
  inherits the writable parent's effective sandbox. Codex native requests and
  spawn attempts fail closed with a provider-sandbox reason; no fallback role
  file is installed. Live governed reattachment preserves the root spawn-gate
  hook and removes stale fallback profiles from earlier builds.
- Claude utility-first launch defines only the bounded read-only fallback
  profile; strict launch disallows `Agent` and legacy `Task`.
- A main-agent fallback request needs exact safe scopes and one through three
  settled utility jobs owned by that requester. Supervisor human exceptions
  are explicit and cannot be self-asserted by a main agent.
- Governess grants one current-epoch lease, denies a competing request, and
  expires an unused or orphaned lease.
- The matching root `Agent`/`spawn_agent` call consumes exactly one lease.
  Strict, unleased, stale, duplicate, wrong-requester, wrong-profile, and
  descendant spawn calls are denied.
- Native child hooks deny file mutation, MCP, web, user-input, nested-agent,
  unscoped, recursive-directory, and symlink-escape attempts. Claude may use
  file-targeted inspection tools. Codex has no governed native-child path.
- Explicit `off` mode leaves root spawn, lifecycle, and child tool events
  outside the native fallback policy.
- Start/stop events bind and close the lease; a new Governess epoch immediately
  fences a running child; lifecycle and denial reasons are visible in the
  Governess board at normal width.
- Small viewports retain Claude, Codex, Nanny, and Au Pair rows.
- Focused tests, `bun run check`, TypeScript, build, `bun run test:ci`,
  base-aware `git diff --check`, and
  `scripts/verify.sh utility-first-native-fallback utility-first-native-fallback`
  pass.
- Independent review is bound to the final accepted code SHA.
