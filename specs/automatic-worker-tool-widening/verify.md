# Verify: Automatic Worker Tool Widening

```bash
cd loop-fork
bun test tests/loop/delegation-policy.test.ts \
  tests/loop/task-router.test.ts \
  tests/loop/utility-tools.test.ts \
  tests/loop/utility-runtime.test.ts \
  tests/loop/utility-store.test.ts \
  tests/loop/governess-hooks.test.ts
bun test
bun run check
bun run build
git diff --check
scripts/verify.sh
```

Security probes must cover:

- test flags, missing paths, full-suite commands, external/symlinked cwd, and
  `npx` download attempts;
- redirections other than exact `2>&1`, command substitution, mutation/network
  chains, and output-filter injection;
- recursive/symlink/protected/oversized directory listings;
- grep regex ambiguity and dangerous options;
- unbounded or malformed awk/tail selectors;
- unknown execution profiles and malformed persisted cwd values.

Live acceptance:

- Confirm installed binary hash equals the independently verified build.
- Record pane IDs/PIDs before and after; Claude and Codex must be unchanged.
- Run `governess doctor` for the active loop and require every check to pass.
- Route one focused test and one new inspection-family canary; each must
  complete using only its expected broker tool with zero failures.
- Confirm usage/cost rows remain stable after the scoped restart.

