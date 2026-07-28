#!/usr/bin/env bash
# Full Loop verification suite. Usage: scripts/verify.sh [feature] [task-id]
set -euo pipefail

FEATURE="${1:-loop-fork}"
TASK_ID="${2:-unknown}"
ARTIFACTS_DIR="runs/${TASK_ID}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "${REPO_ROOT}"
echo "=== verify.sh: task=${TASK_ID} feature=${FEATURE} ==="

echo "--- lint ---"
(cd loop-fork && bun run check)

echo "--- typecheck ---"
(cd loop-fork && bunx tsc --noEmit --skipLibCheck --types bun-types \
  --moduleResolution bundler --module preserve --target esnext \
  src/cli.ts src/loop/caveman-skill.d.ts)

echo "--- build ---"
(cd loop-fork && bun run build)

echo "--- tests ---"
(cd loop-fork && bun run test:ci)

if [[ "${TASK_ID}" != "unknown" ]]; then
  EVAL_FILE="${ARTIFACTS_DIR}/eval.json"
  if [[ ! -f "${EVAL_FILE}" ]]; then
    echo "missing required eval: ${EVAL_FILE}" >&2
    exit 1
  fi
  echo "--- baseline allowlist ---"
  python3 scripts/check-baseline-allowlist.py "${EVAL_FILE}"
fi

echo "=== verify.sh complete ==="
