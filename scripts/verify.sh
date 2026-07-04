#!/usr/bin/env bash
# scripts/verify.sh
# Full verify suite. Run by hooks on task completion and in CI.
# Usage: scripts/verify.sh [--feature <name>] [--task-id <id>]
set -euo pipefail

FEATURE="${1:-}"
TASK_ID="${2:-unknown}"
ARTIFACTS_DIR="runs/${TASK_ID}"

echo "=== verify.sh: task=${TASK_ID} feature=${FEATURE} ==="

# 1. Lint
echo "--- lint ---"
# Replace with your actual lint command:
# npm run lint || yarn lint || ruff check . etc.
echo "[CONFIGURE: add lint command]"

# 2. Typecheck
echo "--- typecheck ---"
# Replace with your actual typecheck command:
# npx tsc --noEmit || mypy . etc.
echo "[CONFIGURE: add typecheck command]"

# 3. Unit tests
echo "--- unit tests ---"
# Replace with your actual test command:
# npm test || pytest etc.
echo "[CONFIGURE: add unit test command]"

# 4. Integration tests (if available)
echo "--- integration tests ---"
# if command -v [integration-test-command] &>/dev/null; then
#   [integration-test-command]
# fi
echo "[CONFIGURE: add integration test command or remove this block]"

# 5. Capture UI if app is running (non-fatal)
if [ -n "${APP_URL:-}" ]; then
  echo "--- UI capture ---"
  bash scripts/capture-ui.sh --out "${ARTIFACTS_DIR}/screenshots/" || \
    echo "WARNING: UI capture failed (non-fatal)"
fi

# 6. Write eval stub if task-id is set
if [ "${TASK_ID}" != "unknown" ]; then
  mkdir -p "${ARTIFACTS_DIR}"
  if [ ! -f "${ARTIFACTS_DIR}/eval.json" ]; then
    cat > "${ARTIFACTS_DIR}/eval.json" <<EOF
{
  "task_id": "${TASK_ID}",
  "feature": "${FEATURE}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "checks": {
    "functional": {"passed": 0, "failed": 0, "details": []},
    "ui": {"passed": 0, "failed": 0, "screenshots": []},
    "performance": {"passed": 0, "failed": 0, "details": []},
    "regression": {"passed": 0, "failed": 0, "details": []}
  },
  "verdict": "pending",
  "notes": "Stub written by verify.sh. Evaluator agent must update verdict."
}
EOF
    echo "eval.json stub written to ${ARTIFACTS_DIR}/eval.json"
  fi
fi

echo "=== verify.sh complete ==="
