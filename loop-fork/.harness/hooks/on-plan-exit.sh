#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

TASK_ID="${1:-}"
if [[ -z "${TASK_ID}" ]]; then
  if [[ ! -f ".harness/current-task" ]]; then
    echo "error: no task id supplied and no .harness/current-task marker" >&2
    exit 1
  fi
  TASK_ID="$(cat .harness/current-task)"
fi
shift || true

exec ./v2/kit/scripts/plan-save.sh "${TASK_ID}" "$@"
