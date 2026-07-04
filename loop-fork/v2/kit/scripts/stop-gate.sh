#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: stop-gate.sh [--json] [task-id]
USAGE
  exit 2
}

JSON_OUTPUT=0
TASK_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      JSON_OUTPUT=1
      shift
      ;;
    --*)
      echo "error: unknown argument: $1" >&2
      usage
      ;;
    *)
      [[ -z "${TASK_ID}" ]] || usage
      TASK_ID="$1"
      shift
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "${TASK_ID}" ]]; then
  CURRENT=".harness/current-task"
  [[ -f "${CURRENT}" ]] || {
    echo "error: missing active task marker: ${CURRENT}" >&2
    exit 1
  }
  TASK_ID="$(cat "${CURRENT}")"
fi

if ! PREFLIGHT_OUTPUT="$("${SCRIPT_DIR}/preflight.sh" "${TASK_ID}" 2>&1)"; then
  if [[ "${JSON_OUTPUT}" -eq 1 ]]; then
    python3 - "${TASK_ID}" "${PREFLIGHT_OUTPUT}" <<'PY'
import json
import sys
print(json.dumps({
    "task_id": sys.argv[1],
    "status": "blocked",
    "error": sys.argv[2],
}, indent=2))
PY
  else
    echo "${PREFLIGHT_OUTPUT}" >&2
  fi
  exit 1
fi

python3 - "${TASK_ID}" "runs/${TASK_ID}/eval.json" "${JSON_OUTPUT}" <<'PY'
import json
import pathlib
import sys

task_id, eval_path, json_output_arg = sys.argv[1:4]
json_output = json_output_arg == "1"
data = json.loads(pathlib.Path(eval_path).read_text(encoding="utf-8"))
required = data.get("required", [])
dimensions = data.get("dimensions", {})
acceptable = {"pass", "skipped", "sign-off-granted"}

blocked = []
for name in required:
    status = dimensions.get(name, {}).get("status", "pending")
    if status not in acceptable:
        blocked.append((name, status))

if blocked:
    if json_output:
        print(json.dumps({
            "task_id": task_id,
            "status": "blocked",
            "blocked": [
                {"dimension": name, "status": status}
                for name, status in blocked
            ],
        }, indent=2))
    else:
        for name, status in blocked:
            print(f"blocked: {name} is {status}", file=sys.stderr)
    raise SystemExit(1)

if json_output:
    print(json.dumps({
        "task_id": task_id,
        "status": "pass",
        "required": required,
    }, indent=2))
else:
    print(f"stop gate passed: {task_id}")
PY
