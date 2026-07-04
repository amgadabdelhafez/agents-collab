#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: post-task.sh <task-id> [--config .harness/config.json] [--artifact-dir <dir>]
USAGE
  exit 2
}

[[ $# -ge 1 ]] || usage

TASK_ID="$1"
shift

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${SCRIPT_DIR}/state-check.sh" "${TASK_ID}" post "$@"

if [[ -d "runs/${TASK_ID}" && -x "${SCRIPT_DIR}/debt-scan.sh" ]]; then
  if ! "${SCRIPT_DIR}/debt-scan.sh" "${TASK_ID}" >&2; then
    echo "warning: debt scan failed for ${TASK_ID}" >&2
  fi
fi

if [[ -d "runs/${TASK_ID}" && -x "${SCRIPT_DIR}/regression-harvest.sh" ]]; then
  if ! "${SCRIPT_DIR}/regression-harvest.sh" "${TASK_ID}" >&2; then
    echo "warning: regression harvest failed for ${TASK_ID}" >&2
  fi
fi
