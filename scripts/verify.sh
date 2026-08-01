#!/usr/bin/env bash
# scripts/verify.sh
# Full verify suite. Run by hooks on task completion and in CI.
# Usage: scripts/verify.sh --task-id <id> [--feature <name>]
set -euo pipefail

usage() {
  echo "usage: scripts/verify.sh --task-id <id> [--feature <name>]" >&2
}

FEATURE=""
TASK_ID=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --task-id)
      TASK_ID="${2:-}"
      shift 2 || { usage; exit 2; }
      ;;
    --feature)
      FEATURE="${2:-}"
      shift 2 || { usage; exit 2; }
      ;;
    *)
      echo "verify.sh: unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

# Fail closed: the release gate reads runs/<task-id>/eval.json. The old
# positional interface silently defaulted TASK_ID=unknown, pointed
# ARTIFACTS_DIR at runs/unknown, and skipped the baseline gate entirely.
if [ -z "${TASK_ID}" ]; then
  echo "verify.sh: --task-id is required (the baseline gate runs against runs/<task-id>/eval.json; there is no default)." >&2
  usage
  exit 2
fi

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

# 6. Write eval stub if absent
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
  "baseline_failures": [],
  "verdict": "pending",
  "notes": "Stub written by verify.sh. Evaluator agent must update verdict."
}
EOF
  echo "eval.json stub written to ${ARTIFACTS_DIR}/eval.json"
fi

# 7. Baseline-failure gate
# Baseline failures are a NAMED allowlist, never a count. The allowlist must be
# empty to release: any named test left on it fails verify. Fail closed: a
# missing eval.json fails the gate instead of skipping it.
echo "--- baseline allowlist ---"
if [ ! -f "${ARTIFACTS_DIR}/eval.json" ]; then
  echo "verify.sh: ${ARTIFACTS_DIR}/eval.json is missing — the baseline gate cannot run, failing closed." >&2
  exit 1
fi
python3 scripts/check-baseline-allowlist.py "${ARTIFACTS_DIR}/eval.json"

echo "=== verify.sh complete ==="
