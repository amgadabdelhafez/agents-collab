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
- 2026-07-30T08:46:00Z — Independent review caught that the initial detector
  used a clean environment but delegated rendering back to ambient `parseArgs`.
  Separated a config-independent information renderer, added invalid ambient
  Caveman regressions, and superseded the first review request before verdict.
  Focused coverage now passes 99/0.
- 2026-07-30T09:07:08Z — Smoke review found that a confirmed-dead workspace
  could throw after startup while leaving its exact manifest active. Unified
  paired pre-handoff failure accounting across the outer liveness probe,
  attach race, optional remain-on-exit failure, and final handoff check.
  Active manifests become `failed`; completed manifests remain completed;
  unknown tmux liveness has no cleanup authority; external app-server
  ownership remains recorded. Focused tmux coverage passes 71/0.
- 2026-07-30T09:07:08Z — Removed two smoke false-greens: every disposable home
  now starts with a fresh update throttle, and every generated charter must
  contain the complete randomized source prompt buffer at greater than 8 KiB.
  The missing-workspace case must persist `failed/failed`. Runtime execution
  remains held until run-101 governed teardown.
- 2026-07-30T09:20:00Z — Tightened all paired pre-bind, layout, attach, and
  handoff probes to tri-state liveness. Only recognized no-server/no-session
  evidence grants failure authority; timeout, exceptions, and unrecognized
  nonzero exits preserve active state and transport ownership. A fresh live
  probe overrides stale attach errors. Lint, source typecheck, compiled build,
  and the complete sequential suite pass with an empty baseline-failure list.
- 2026-07-30T16:19:18Z — The post-teardown realistic smoke superseded reviewed
  candidate `888fe36`: macOS's long temporary root overflowed tmux's Unix-socket
  path, and the normal cold-socket `No such file or directory` response was
  misclassified as unknown before any session could be created.
- 2026-07-30T16:19:18Z — Added a short physical `/tmp` smoke root, a 103-byte
  socket-path assertion, and scoped cold-socket recognition to the initial
  pre-resource probe only. Later missing-socket, permission, timeout, and
  overlong-path failures retain unknown semantics and no cleanup authority.
- 2026-07-30T16:19:18Z — The isolated 10 KiB smoke passes outside the managed
  socket-binding sandbox: named session and both panes exist, full charters and
  hash-bound bootstraps verify, tampering fails closed, nested help is read-only,
  and missing workspace exits 1 with a durable `failed/failed` manifest. The
  certified sequential suite also passes. Fresh exact-SHA review is required.
- 2026-07-30T16:24:35Z — Harness `isolated-smoke` attempt 001 passed against
  exact code commit `698e86bc77d5c34e17bda87643c628220b11f488`; replayable evidence is
  `loop-fork/runs/informational-command-no-maintenance/artifacts/isolated-smoke/verify.log`.
  The rebuilt binary remained byte-identical at SHA-256
  `ca7df916f4431ade5b4e1af7d7cf33eae0c31eca0c99792cd0fe9028b43dacaf`.
- 2026-07-30T16:41:24Z — Claude issued exact-SHA CONCUR for clean commit
  `cf2d0c961990cc0c459c8d8999c72fdf0a70d0a8` in channel message
  `dc79d52a-aadb-4627-97b8-4e6774900ec7`, independently passing `test:ci`
  1318/0, reproducing binary SHA-256
  `ca7df916f4431ade5b4e1af7d7cf33eae0c31eca0c99792cd0fe9028b43dacaf`, and
  passing the cold-server launch smoke on the affected machine.
- 2026-07-30T17:04:00Z — The post-deploy section-4 smoke passed functionally
  but rebuilt canonical in place before launch, changing installed SHA-256
  from reviewed `ca7df916...` to unreviewed `49da0ef6...`. Restored the exact
  reviewed bytes atomically, verified canonical/global hashes, and held launch.
- 2026-07-30T17:12:30Z — Harness `isolated-smoke` attempt 002 passed using the
  physical installed binary and a PATH wrapper that fails any attempted
  `bun run build`. The output binds `prebuilt=1`, the physical canonical path,
  and SHA-256
  `ca7df916f4431ade5b4e1af7d7cf33eae0c31eca0c99792cd0fe9028b43dacaf`;
  external before/after hashes match, no tmux server or temp root remains, and
  a separate self-mutating fixture proves EXIT cleanup detects byte drift.
- 2026-07-30T17:13:30Z — The formatter, shell syntax check, diff check, and
  complete sequential `test:ci` suite pass. A separate read-only audit found
  no remaining exact-binary-mode logic blocker and confirmed post-review QA
  must not invoke the build-bearing aggregate wrappers.
- 2026-07-30T17:18:30Z — Moved default smoke compilation to disposable
  `${SMOKE_ROOT}/build/loop`. The full default 10 KiB smoke passed from that
  path with `prebuilt=0`; candidate, canonical, and global binaries remained
  byte-identical at `ca7df916...`, and cleanup left no tmux server or temp root.
- 2026-07-30T17:19:30Z — Harness `isolated-smoke` attempt 003 passed against
  the physical installed binary with a wrapper forbidding both direct
  `bun build` and package-script `bun run build`; output again binds
  `prebuilt=1` and exact SHA-256 `ca7df916...`.
- 2026-07-30T17:20:38Z — Harness `default-smoke` attempt 001 separately banked
  the full disposable-build path and pass. All three persistent binary paths
  remained byte-identical at `ca7df916...` after cleanup.
- 2026-07-30T17:25:30Z — Claude issued CONCUR for exact clean SHA
  `2ca7439384f05b02c19b40af71dd1cafbc878b96` in message
  `fd3cff50-4c61-4a43-8d9d-67d4abf73bd7`, independently passing both default
  disposable-build and exact installed-binary smoke modes with hashes unchanged.

Regression: yes
Regression id: nested-info-runs-maintenance
Regression symptom: A nested help request can rewrite a live run manifest and signal its registered transports before printing help.
Regression guard: `bun test tests/loop.test.ts tests/loop/args.test.ts`
