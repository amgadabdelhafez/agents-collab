#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: plan-save.sh <task-id> [--file <path>]

Reads plan text from --file, HARNESS_PLAN_TEXT, or stdin, then writes
runs/<task-id>/plan.md.
USAGE
  exit 2
}

[[ $# -ge 1 ]] || usage

TASK_ID="$1"
shift
INPUT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file)
      [[ $# -ge 2 ]] || usage
      INPUT_FILE="$2"
      shift 2
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage
      ;;
  esac
done

RUN_DIR="runs/${TASK_ID}"
PLAN_PATH="${RUN_DIR}/plan.md"
[[ -d "${RUN_DIR}" ]] || {
  echo "error: missing run dir: ${RUN_DIR}" >&2
  exit 1
}

if [[ -n "${INPUT_FILE}" ]]; then
  [[ -f "${INPUT_FILE}" ]] || {
    echo "error: missing plan input file: ${INPUT_FILE}" >&2
    exit 1
  }
  CONTENT="$(cat "${INPUT_FILE}")"
elif [[ -n "${HARNESS_PLAN_TEXT:-}" ]]; then
  CONTENT="${HARNESS_PLAN_TEXT}"
else
  CONTENT="$(cat)"
fi

[[ -n "${CONTENT//[[:space:]]/}" ]] || {
  echo "error: plan content is empty" >&2
  exit 1
}

python3 - "${TASK_ID}" "${PLAN_PATH}" "${CONTENT}" <<'PY'
import pathlib
import sys
from datetime import datetime, timezone

task_id, plan_path, content = sys.argv[1:4]
path = pathlib.Path(plan_path)
saved_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
text = content.strip() + "\n"
if not text.lstrip().startswith("#"):
    text = f"# {task_id} Plan\n\nSaved: {saved_at}\n\n{text}"
path.write_text(text, encoding="utf-8")
print(str(path))
PY
