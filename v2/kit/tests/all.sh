#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "${ROOT_DIR}"

tests=(
  "./v2/kit/tests/smoke.sh"
  "./v2/kit/tests/state-invariants.sh"
  "./v2/kit/tests/eval-dimensions.sh"
  "./v2/kit/tests/mode-init.sh"
  "./v2/kit/tests/investigation-done.sh"
  "./v2/kit/tests/done-gate.sh"
  "./v2/kit/tests/park-activate.sh"
  "./v2/kit/tests/idea-capture.sh"
  "./v2/kit/tests/debt-scan.sh"
  "./v2/kit/tests/regression-harvest.sh"
  "./v2/kit/tests/active-task-guard.sh"
  "./v2/kit/tests/verify-wrapper.sh"
  "./v2/kit/tests/hook-preflight.sh"
  "./v2/kit/tests/hook-wrappers.sh"
  "./v2/kit/tests/coordination-lite.sh"
  "./v2/kit/tests/agent-coordination.sh"
  "./v2/kit/tests/tracker-plugin.sh"
  "./v2/kit/tests/audit-runner.sh"
  "./v2/kit/tests/parallel-guards.sh"
  "./v2/kit/tests/status-json.sh"
  "./v2/kit/tests/gate-json.sh"
  "./v2/kit/tests/plan-init.sh"
  "./v2/kit/tests/plan-save.sh"
  "./v2/kit/tests/loop-prompt.sh"
  "./v2/kit/tests/research-gate.sh"
  "./v2/kit/tests/session-export.sh"
  "./v2/kit/tests/retrospect.sh"
  "./v2/kit/tests/cli-help.sh"
)

for test_script in "${tests[@]}"; do
  echo "==> ${test_script}"
  "${test_script}"
done

echo "all: all checks passed"
