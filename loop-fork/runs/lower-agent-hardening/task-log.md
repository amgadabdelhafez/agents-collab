# Task lower-agent-hardening

Created: 2026-07-26T16:12:05Z
Mode: planned
Description: Harden configurable checks, worker supervision, guarded patch application, environment isolation, diagnostics, and run budgets

## What I changed

- Added strict repository command-policy loading and local/offline
  `npx vitest run <scoped-file>` support.
- Added PID-bearing worker claims and governess-owned dead/runtime reaping.
- Added full-agent-only guarded patch application with patch+manifest hashes,
  immediate preimage verification, canonical write-scope checks, and durable
  postimages.
- Replaced inherited worker environments with an allowlist and key-file-only
  production launch path.
- Persisted safe availability detail in route decisions and rendered it in the
  observer pane.
- Added pessimistic estimate-less reservations and a $0.25 default run cap.

## Why

These changes close the supervisor's six pre-next-loop operational findings
without moving authority into the lower agent or adding forced delegation.

## Notes

- The existing utility job journal already records every requested task and
  route target/reason, which is the instrument-first dataset for delegation
  hit-rate analysis.
- `bun run check` cannot start in this checkout because `ultracite` is declared
  but `node_modules/.bin/ultracite` is absent. Build and focused tests run with
  the existing Bun toolchain.
- Harness focused verification passes 270 tests. The full suite passes 701 and
  has the same four unrelated default-Codex-model expectation failures present
  before this slice. `bun run build`, `git diff --check`, and direct Biome lint
  of changed lower-agent files pass; only a pre-existing unused suppression is
  reported.
- Live loop 43 was not messaged, restarted, signaled, re-paned, or given a
  repository configuration mutation.
- Integrated locally as canonical commits `8d053fe` and `877806e`, rebuilt and
  installed SHA-256 `57be1e8e...`, and preserved the prior binary under
  `/Users/amgad/.loop/release-backups/`.
- Disposable tmux smoke rendered a 59x8 `z-ai/glm-5.2 READY` observer. An
  installed MCP probe included `apply_task_patch`; a fake-runner Harvto probe
  resolved nested package-local Vitest with npm offline and prompting disabled.
- Loop 43 retained pane IDs `%0/%1/%2/%4` and PIDs
  `82463/82465/82880/84862` after release.
