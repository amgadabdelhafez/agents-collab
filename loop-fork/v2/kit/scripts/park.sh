#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: park.sh <task-id>
USAGE
  exit 2
}

[[ $# -eq 1 ]] || usage

TASK_ID="$1"
RUN_DIR="runs/${TASK_ID}"
META="${RUN_DIR}/meta.json"
CURRENT=".harness/current-task"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ -f "${META}" ]] || {
  echo "error: missing meta file: ${META}" >&2
  exit 1
}

python3 - "${TASK_ID}" "${META}" <<'PY'
import json
import pathlib
import sys
from datetime import datetime, timezone

task_id, meta_path = sys.argv[1:3]
path = pathlib.Path(meta_path)
meta = json.loads(path.read_text(encoding="utf-8"))
if meta.get("id") != task_id:
    raise SystemExit(f"error: meta id mismatch: {meta.get('id')} != {task_id}")
if meta.get("status") == "done":
    raise SystemExit(f"error: cannot park completed task: {task_id}")
meta["status"] = "parked"
meta["parked_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
PY

if [[ -f "${CURRENT}" ]] && [[ "$(cat "${CURRENT}")" == "${TASK_ID}" ]]; then
  rm -f "${CURRENT}"
fi

if [[ -x "${SCRIPT_DIR}/tasks-index.sh" ]]; then
  "${SCRIPT_DIR}/tasks-index.sh" refresh "${TASK_ID}" >/dev/null
fi

echo "${RUN_DIR}"
