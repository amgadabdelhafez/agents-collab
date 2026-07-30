# Informational command safety task log

- 2026-07-30T08:13:38Z — Opened an isolated worktree from exact deployed
  commit `2a2ccd0b93b48a0005e79a34b5d43531eb0b0820`. Run-101 remains read-only.
- 2026-07-30T08:15:20Z — Confirmed the failure boundary: only an information
  flag in argv position zero bypasses maintenance; `collab --help` reaches the
  three global startup sweeps. Registered parser-exact value/delimiter
  negatives and full smoke-environment isolation as acceptance requirements.
- 2026-07-30T08:23:00Z — Added a side-effect-free information probe that uses
  the real parser traversal, then moved it ahead of public utility commands,
  hidden helpers, and startup maintenance. Focused parser/CLI tests pass 95/0;
  lint, source typecheck, and compiled build pass.
- 2026-07-30T08:29:00Z — Hardened the realistic prompt smoke with `env -i`,
  distinct per-case HOME/Claude/Codex/tmux roots, fixed unique run IDs, exact
  manifest identity/containment assertions, and read-only real-home absence
  checks. Static shell validation passes; execution remains held by run-101.
- 2026-07-30T08:29:00Z — Full sequential `bun run test:ci` passes outside the
  localhost-binding sandbox. A first sandboxed attempt failed only at the
  Codex proxy's ephemeral listener with `EADDRINUSE`; the exact file and full
  suite pass when allowed to bind localhost.
- 2026-07-30T08:35:00Z — The mandated `scripts/verify.sh` passed lint,
  typecheck, build, and every sequential test, then stopped exactly at the
  release gate because `eval.json` remains intentionally `pending` until
  exact-SHA review and post-teardown isolated smoke.

Regression: yes
Regression id: nested-info-runs-maintenance
Regression symptom: A nested help request can rewrite a live run manifest and signal its registered transports before printing help.
Regression guard: `bun test tests/loop.test.ts tests/loop/args.test.ts`
