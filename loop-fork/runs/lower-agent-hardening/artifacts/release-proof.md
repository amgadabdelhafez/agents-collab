# Lower-Agent Hardening Release Proof

## Integrated source and install

- Canonical branch: `feat/babysitter-pane`
- Integrated commits: `8d053fe` (spec) and `877806e` (implementation)
- Global entrypoint:
  `/Users/amgad/.local/bin/loop -> /Users/amgad/dev_projects/agents-collab/loop-fork/loop`
- Installed/canonical SHA-256:
  `57be1e8ee138a5ae1b2e27522bfab33e16092263d184c71892614c7f9b78af1f`
- Recoverable previous binary:
  `/Users/amgad/.loop/release-backups/loop.pre-lower-agent-hardening.20260726T164500Z`
- Previous binary SHA-256:
  `8a82d58f7fb95ae522f97e0b4ed790c8005bdd9d4787bc4d0e7fd5e25bf51152`
- No remote push.

## Verification

- Harness focused suite: 270 pass, 0 fail, 988 expectations.
- Full suite: 701 pass, with the same four unrelated current-Codex-model
  expectation failures present before the slice.
- `bun run build`: pass.
- `git diff --check`: pass.
- Direct Biome lint of changed lower-agent files: pass with one pre-existing
  unused suppression warning. The repository's `bun run check` wrapper cannot
  start because its local `ultracite` executable is absent.

## Installed surface smoke

A disposable 120x32 tmux session used inert `sleep` panes and the installed
binary. Its top-right observer was 59x8 and rendered:

```text
LOWER AGENT  z-ai/glm-5.2  READY
STATUS  active=0 queued=0 done=0 failed=0
NOW  idle; waiting for governess routing
CONFIG  credential loaded from mode-safe key file
```

The external key was reported as a regular mode-0600 file. The disposable
session was removed. An installed-binary MCP probe listed `route_task`,
`task_status`, `get_task_result`, and the new full-agent-only
`apply_task_patch`, plus the bridge tools.

## Harvto command boundary

A read-only broker probe against `/Users/amgad/harvto` resolved:

```text
cwd:  /Users/amgad/harvto/03-Development/ar-prototype
argv: npx vitest run tests/wo2-yaw-select.test.js
env:  NPM_CONFIG_OFFLINE=true, NPM_CONFIG_YES=false
```

The probe used a fake command runner, so it validated Harvto's nested local
Vitest boundary without executing tests or mutating the active repository.

## Loop-43 non-interruption invariant

Before and after integration/install, `harvto-loop-43` retained:

| Pane | PID | Command |
|---|---:|---|
| `%0` | 82463 | `claude` |
| `%1` | 82465 | `codex-aarch64-a` |
| `%2` | 82880 | `loop` |
| `%4` | 84862 | `node` |

No pane input, bridge message, signal, restart, re-pane, or Harvto
configuration mutation was performed.
