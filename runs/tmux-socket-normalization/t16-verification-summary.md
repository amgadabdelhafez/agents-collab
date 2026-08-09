# T-16 full verification summary

Captured: 2026-08-09
Candidate commit before final evidence commit: `fccabae463bb2d01fff0cfd547a303ad36f48b2d`
Compiled candidate SHA-256: `cdc1d1ff88c479d4c6793830b5b3c7c936a6892ecd90498b906a843445861f47`

## Repository gates

- `bun run check`: PASS, 205 source-owned files, no fixes applied.
- Exact documented TypeScript command: PASS.
- `bun run build`: PASS, 3,054 modules; candidate hash above.
- `env -u TMUX -u TMUX_PANE bun run test:ci`: PASS outside the localhost-bind
  sandbox, 86 test files, 1,822 pass, 0 fail, no tolerated failure.
- `tests/install.test.ts`: 4 pass, 0 fail. Release packaging: 1 pass, 0 fail.

The first sandboxed complete-suite attempt reached
`codex-tmux-proxy.integration.test.ts` and failed to bind an isolated localhost
port. The exact test passed 1/1 outside the sandbox, and the full suite was then
rerun outside that bind restriction and passed in full. This is retained as an
instrument attempt, not counted as a product baseline failure.

The initial static and type gates found two operational prerequisites. D-029
excluded immutable `runs/**` evidence from source formatting while preserving a
positive source probe; D-030 corrected a type-only `ManifestHandle` import.
Both have separate specs, passing independent evals, and commit `9019e52`.
The first T-17 review then found that the authoritative verify-10 record was
still open and exposed a real observability gap in Governess degraded effects.
D-031 closed that gap in commit `fccabae` with 121 focused tests and an
independent pass before this entire candidate matrix was rerun.

The historical D-015 task remains immutable as `done` with its original failed
eval because it records an earlier attach attempt. D-016 and the later D-017
through D-031 slices supersede that attempt; the final 86-file suite and
two-server matrix certify the current candidate. The old eval is evidence, not
a tolerated current baseline failure.

## Producer smokes

- `bash evals/smoke/tmux-socket-normalization.sh`: PASS outside the process
  sandbox; 27 consumers, 74 per-seam exact-A contacts, same-name B decoy
  unchanged, trap/signal/positive PID controls PASS, and zero cleanup residue.
- `bash evals/smoke/large-prompt-launch.sh`: PASS; candidate `cdc1d1ff…`,
  exact-socket OSS/Claude launch, bootstrap, timeout preservation, hash failure,
  and missing-workspace failure all verified.
- `bash evals/smoke/active-launch-interlock.sh`: PASS; candidate `cdc1d1ff…`,
  one same-workspace winner, immutable cold resume, distinct worktree allowed.
- `bash evals/smoke/paste-submit-readiness.sh`: PASS; rebuilt candidate remains
  `cdc1d1ff…`, exact-socket OSS/Claude launch and ledger-only bridge pull pass.

Sandboxed smoke attempts that could not create their isolated tmux/process
fixtures are retained in attempt logs; every final smoke ran with the narrow
required authority and performed its own exact cleanup.

## No-mutation and scope

- Final pre/post inventories cover all 1,747 files under `loop-fork/runs/`.
- Each row records relative path, bytes, Unix mtime, and SHA-256.
- Pre and post files compare byte-identical and both hash to
  `10c6905f66105948abb30572602aa4e5424ba1578cebc9f37dc5bf4c305b2bb7`.
- `scripts/refresh-dependency-map.sh` ran; the refreshed map now records the
  manifest-handle and derived tmux capability dependency boundary.
- Installed `/Users/amgad/.local/bin/loop` remains v1.0.38 at SHA-256
  `88dcfe2d6bacb6ff6083dde31fbee96fae608d54eff5861e0763310c98810bf5`.
- Harvto was not inspected, addressed, signalled, or mutated.
- No global install, merge, push, deployment, product-lane action, or
  modernization change occurred.
- `bun run fix` was never run.

## Independent evaluation and governed verification

- Independent T-17 evaluation: PASS; eval SHA-256
  `e5094dbab3aa67776018e81632c9e40f25bde2512a9957fa7ed4d204393914fa`.
- `baseline_failures` is exactly empty; historical D-015 is recorded as
  superseded evidence, not a current allowance.
- `scripts/verify.sh tmux-socket-normalization tmux-socket-normalization`:
  PASS after the independent eval, including migration guard, static check,
  exact typecheck, rebuild, complete test suite, and empty baseline allowlist.
- Terminal UI screenshots/DOM are not applicable; exact render assertions and
  isolated tmux capture evidence cover the terminal-only output surface.
