#!/usr/bin/env bash
set -euo pipefail

MARKER=".harness/current-task"

if [[ ! -f "${MARKER}" ]]; then
  echo "current-task: no active marker"
  exit 0
fi

TASK_ID="$(cat "${MARKER}")"
if [[ -z "${TASK_ID}" ]]; then
  echo "current-task: marker is empty" >&2
  exit 1
fi

RUN_DIR="runs/${TASK_ID}"
META="${RUN_DIR}/meta.json"

if [[ ! -d "${RUN_DIR}" ]]; then
  echo "current-task: missing run dir: ${RUN_DIR}" >&2
  exit 1
fi

if [[ ! -f "${META}" ]]; then
  echo "current-task: missing meta file: ${META}" >&2
  exit 1
fi

python3 - "${TASK_ID}" "${META}" <<'PY'
import json
import pathlib
import sys

task_id, meta_path = sys.argv[1:3]
meta = json.loads(pathlib.Path(meta_path).read_text(encoding="utf-8"))
if meta.get("id") != task_id:
    raise SystemExit(f"current-task: meta id mismatch: {meta.get('id')} != {task_id}")
if meta.get("status") != "active":
    raise SystemExit(f"current-task: expected active status, got {meta.get('status')}")
print(f"current-task: active {task_id}")
PY
