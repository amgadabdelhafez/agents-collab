#!/usr/bin/env bash
# Full Loop verification suite. Usage: scripts/verify.sh <feature> <task-id>
set -euo pipefail

if [[ "$#" -ne 2 || -z "${1}" || -z "${2}" ]]; then
  echo "usage: scripts/verify.sh <feature> <task-id>" >&2
  echo "a task id is required so eval and baseline gates cannot be skipped" >&2
  exit 2
fi

FEATURE="${1}"
TASK_ID="${2}"
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

EVAL_FILE="${ARTIFACTS_DIR}/eval.json"
if [[ ! -f "${EVAL_FILE}" ]]; then
  echo "missing required eval: ${EVAL_FILE}" >&2
  exit 1
fi
echo "--- baseline allowlist ---"
python3 scripts/check-baseline-allowlist.py "${EVAL_FILE}"

echo "=== verify.sh complete ==="
