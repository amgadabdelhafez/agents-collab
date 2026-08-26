#!/usr/bin/env bash
set -euo pipefail

tests=(
  tests/loop/run-state.test.ts
  tests/loop/paired-options.test.ts
  tests/loop/tmux-control.test.ts
  tests/loop/tmux.test.ts
  tests/loop/control-surface/projection.test.ts
  tests/loop/control-surface/sources.test.ts
  tests/loop/control-surface/timeline.test.ts
  tests/webui/theme.test.ts
  tests/webui/tailscale.test.ts
  tests/webui/exact-host-guard.test.ts
  tests/webui/harvto-live-data.test.ts
  tests/webui/render.test.tsx
)

for test_file in "${tests[@]}"; do
  bun run test:file -- "$test_file"
done
