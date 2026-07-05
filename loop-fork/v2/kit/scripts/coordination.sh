#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage:
  coordination.sh write <task-id> --intent <intent> [--file <path>] [--agent <id>]
  coordination.sh tail [--limit <n>] [--json] [--file <path>]
USAGE
  exit 2
}

[[ $# -ge 1 ]] || usage

COMMAND="$1"
shift
LOG="agents/coordination.jsonl"

default_agent() {
  if [[ -n "${HARNESS_AGENT_ID:-}" ]]; then
    printf '%s\n' "${HARNESS_AGENT_ID}"
  elif [[ -n "${USER:-}" ]]; then
    printf '%s-%s\n' "${USER}" "$$"
  else
    printf 'agent-%s\n' "$$"
  fi
}

case "${COMMAND}" in
  write)
    [[ $# -ge 1 ]] || usage
    TASK_ID="$1"
    shift
    INTENT=""
    FILE_PATH=""
    AGENT_ID="$(default_agent)"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --intent)
          [[ $# -ge 2 ]] || usage
          INTENT="$2"
          shift 2
          ;;
        --file)
          [[ $# -ge 2 ]] || usage
          FILE_PATH="$2"
          shift 2
          ;;
        --agent)
          [[ $# -ge 2 ]] || usage
          AGENT_ID="$2"
          shift 2
          ;;
        *)
          echo "error: unknown argument: $1" >&2
          usage
          ;;
      esac
    done
    [[ -n "${INTENT}" ]] || {
      echo "error: write requires --intent" >&2
      exit 2
    }
    mkdir -p "agents"
    python3 - "${LOG}" "${TASK_ID}" "${INTENT}" "${FILE_PATH}" "${AGENT_ID}" <<'PY'
import json
import pathlib
import sys
from datetime import datetime, timezone

log_path, task_id, intent, file_path, agent_id = sys.argv[1:6]
row = {
    "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "agent": agent_id,
    "task": task_id,
    "intent": intent,
    "file": file_path or None,
}
path = pathlib.Path(log_path)
path.parent.mkdir(parents=True, exist_ok=True)
with path.open("a", encoding="utf-8") as f:
    f.write(json.dumps(row) + "\n")
print(json.dumps(row))
PY
    ;;
  tail)
    LIMIT=20
    JSON_OUTPUT=0
    FILE_FILTER=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --limit)
          [[ $# -ge 2 ]] || usage
          LIMIT="$2"
          shift 2
          ;;
        --json)
          JSON_OUTPUT=1
          shift
          ;;
        --file)
          [[ $# -ge 2 ]] || usage
          FILE_FILTER="$2"
          shift 2
          ;;
        *)
          echo "error: unknown argument: $1" >&2
          usage
          ;;
      esac
    done
    python3 - "${LOG}" "${LIMIT}" "${JSON_OUTPUT}" "${FILE_FILTER}" <<'PY'
import json
import pathlib
import sys

log_path, limit, json_output, file_filter = sys.argv[1:5]
limit = int(limit)
json_output = json_output == "1"
path = pathlib.Path(log_path)
rows = []
if path.exists():
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        rows.append(json.loads(line))
if file_filter:
    rows = [row for row in rows if row.get("file") == file_filter]
rows = rows[-limit:]
if json_output:
    print(json.dumps({"coordination": rows}, indent=2))
else:
    if not rows:
        print("no coordination entries")
    for row in rows:
        file_part = f" file={row.get('file')}" if row.get("file") else ""
        print(f"{row.get('ts')} {row.get('agent')} task={row.get('task')} intent={row.get('intent')}{file_part}")
PY
    ;;
  *)
    echo "error: unknown command: ${COMMAND}" >&2
    usage
    ;;
esac
