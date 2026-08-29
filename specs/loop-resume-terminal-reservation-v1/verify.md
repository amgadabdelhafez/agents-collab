# Verification contract

## Identity and scope

- Base integration SHA is exactly
  `62e8103d9181bad85012830f8170cca8e21fd0d6`.
- Product/test allowlist:
  - `loop-fork/src/loop/run-state.ts`
  - `loop-fork/src/loop/launch-reservation.ts`
  - `loop-fork/tests/fixtures/loop-resume-terminal-reservation-v1/**`
  - `loop-fork/tests/loop/run-state.test.ts`
  - `loop-fork/tests/loop/launch-reservation.test.ts`
  - `runs/loop-resume-terminal-reservation-v1/**`
  - `specs/loop-resume-terminal-reservation-v1/**`
- No lockfile, dependency, provider, model, Web UI, device, or installed-runtime
  path may change in the candidate.

## Required cases

1. Exact Run 42: terminal plus valid release, dead PID 9598, absent launch PID,
   absent legacy tmux target and workspace. Fresh reservation succeeds.
2. Active state plus release marker: refuses.
3. Terminal without release marker: refuses when legacy target is unknown.
4. Terminal with invalid release marker: refuses.
5. Terminal released with live run PID: refuses.
6. Terminal released with live launch-attempt PID: refuses.
7. Terminal released with live tmux target: refuses.
8. Terminal released with usable target whose liveness is unknown: refuses.
9. Every refused case preserves manifest bytes and creates no new run.

## Gates

```bash
bun test tests/loop/run-state.test.ts tests/loop/launch-reservation.test.ts
bun run test:ci
bun run check
bun run build
git diff --check
```

The full suite report must name the failure set and require it to be empty.
Passing counts alone are insufficient.

## Review and runtime certification

- Freeze and report exact candidate and parent SHAs.
- A separate reviewer returns literal `PASS` or `REFUSE` for the exact SHA and
  performs zero writes.
- Before installation, remeasure the built committed blob and obtain fresh
  install authority.
- After installation, record `shasum -a 256 /Users/amgad/.local/bin/loop` and
  `loop --version`, then rerun the exact explicit `--tmux` launch that Run 42
  blocked. Success requires tmux session existence, both agent identities,
  initial hook progression, and bridge liveness.
