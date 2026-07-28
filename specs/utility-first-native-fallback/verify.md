# Utility-first native fallback verification

- Default mode is `utility-first`; unknown mode is `strict`; `off` is explicit.
- Codex config has one native thread in utility-first and disables agents in
  strict. Its fallback profile is read-only; disables unified execution, web
  search, the loop bridge MCP server, remote plugins, and descendants; and
  exposes only a hook-validated `shell_command` inspection grammar over
  existing regular files. Approved calls require fixed system binaries,
  canonical absolute operands/workdir, a non-login shell, and clean
  environment.
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
  unscoped, recursive-directory, compound-command, and symlink-escape attempts.
  Claude may use file-targeted inspection tools; Codex may use only the
  documented bounded read commands.
- Explicit `off` mode leaves root spawn, lifecycle, and child tool events
  outside the native fallback policy.
- Start/stop events bind and close the lease; lifecycle and denial reasons are
  visible in the Governess board at normal width.
- Small viewports retain Claude, Codex, Nanny, and Au Pair rows.
- Focused tests, `bun run check`, TypeScript, build, `bun run test:ci`,
  base-aware `git diff --check`, and
  `scripts/verify.sh utility-first-native-fallback utility-first-native-fallback`
  pass.
- Independent review is bound to the final accepted code SHA.
