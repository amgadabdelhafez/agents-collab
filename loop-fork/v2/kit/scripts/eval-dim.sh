#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage:
  eval-dim.sh init <task-id> [--required dim,dim]
  eval-dim.sh set <task-id> <dimension> <status> [--artifact path] [--reason text] [--method text] [--signed-off-by name]
  eval-dim.sh aggregate <task-id>
USAGE
  exit 2
}

[[ $# -ge 2 ]] || usage

COMMAND="$1"
TASK_ID="$2"
shift 2

RUN_DIR="runs/${TASK_ID}"
EVAL="${RUN_DIR}/eval.json"

valid_status() {
  case "$1" in
    pending|pass|fail|skipped|sign-off-granted) return 0 ;;
    *) return 1 ;;
  esac
}

case "${COMMAND}" in
  init)
    REQUIRED="unit"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --required)
          [[ $# -ge 2 ]] || usage
          REQUIRED="$2"
          shift 2
          ;;
        *)
          echo "error: unknown argument: $1" >&2
          usage
          ;;
      esac
    done
    mkdir -p "${RUN_DIR}"
    python3 - "${TASK_ID}" "${EVAL}" "${REQUIRED}" <<'PY'
import json
import pathlib
import sys

task_id, eval_path, required_csv = sys.argv[1:4]
required = [item.strip() for item in required_csv.split(",") if item.strip()]
dimensions = {
    name: {"status": "pending"}
    for name in required
}
data = {
    "task_id": task_id,
    "status": "pending",
    "required": required,
    "dimensions": dimensions,
}
pathlib.Path(eval_path).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
    echo "${EVAL}"
    ;;
  set)
    [[ $# -ge 2 ]] || usage
    DIMENSION="$1"
    STATUS="$2"
    shift 2
    valid_status "${STATUS}" || {
      echo "error: invalid status: ${STATUS}" >&2
      exit 2
    }
    ARTIFACT=""
    REASON=""
    METHOD=""
    SIGNED_OFF_BY=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --artifact)
          [[ $# -ge 2 ]] || usage
          ARTIFACT="$2"
          shift 2
          ;;
        --reason)
          [[ $# -ge 2 ]] || usage
          REASON="$2"
          shift 2
          ;;
        --method)
          [[ $# -ge 2 ]] || usage
          METHOD="$2"
          shift 2
          ;;
        --signed-off-by)
          [[ $# -ge 2 ]] || usage
          SIGNED_OFF_BY="$2"
          shift 2
          ;;
        *)
          echo "error: unknown argument: $1" >&2
          usage
          ;;
      esac
    done
    [[ -f "${EVAL}" ]] || {
      echo "error: missing eval file: ${EVAL}" >&2
      exit 1
    }
    python3 - "${EVAL}" "${DIMENSION}" "${STATUS}" "${ARTIFACT}" "${REASON}" "${METHOD}" "${SIGNED_OFF_BY}" <<'PY'
import json
import pathlib
import sys

eval_path, dimension, status, artifact, reason, method, signed_off_by = sys.argv[1:8]
path = pathlib.Path(eval_path)
data = json.loads(path.read_text(encoding="utf-8"))
data.setdefault("required", [])
dimensions = data.setdefault("dimensions", {})
record = dimensions.setdefault(dimension, {})
record["status"] = status
if artifact:
    record["artifact"] = artifact
if reason:
    record["reason"] = reason
if method:
    record["method"] = method
if signed_off_by:
    record["signed_off_by"] = signed_off_by
dimensions[dimension] = record
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
    "${BASH_SOURCE[0]}" aggregate "${TASK_ID}" >/dev/null
    echo "${EVAL}"
    ;;
  aggregate)
    [[ -f "${EVAL}" ]] || {
      echo "error: missing eval file: ${EVAL}" >&2
      exit 1
    }
    python3 - "${EVAL}" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8"))
required = data.get("required", [])
dimensions = data.get("dimensions", {})

missing = [name for name in required if name not in dimensions]
statuses = {name: dimensions.get(name, {}).get("status", "pending") for name in required}

if missing:
    overall = "pending"
elif any(status == "fail" for status in statuses.values()):
    overall = "fail"
elif all(status in ("pass", "skipped", "sign-off-granted") for status in statuses.values()):
    overall = "pass"
else:
    overall = "pending"

data["status"] = overall
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
print(overall)
PY
    ;;
  *)
    echo "error: unknown command: ${COMMAND}" >&2
    usage
    ;;
esac
