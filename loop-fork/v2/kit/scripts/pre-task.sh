#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: pre-task.sh <task-id> [--config .harness/config.json] [--artifact-dir <dir>]
USAGE
  exit 2
}

[[ $# -ge 1 ]] || usage

TASK_ID="$1"
shift

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${SCRIPT_DIR}/state-check.sh" "${TASK_ID}" pre "$@"
