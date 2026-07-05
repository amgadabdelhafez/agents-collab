#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage:
  tasks-index.sh refresh <task-id>
  tasks-index.sh mark-done <task-id> <spec-path>
  tasks-index.sh rebuild
  tasks-index.sh list [--json] [--status active|parked|done] [--eval pending|pass|fail|missing]
USAGE
  exit 2
}

[[ $# -ge 1 ]] || usage

COMMAND="$1"
shift
INDEX=".harness/tasks.json"

case "${COMMAND}" in
  refresh|mark-done)
    if [[ "${COMMAND}" == "refresh" ]]; then
      [[ $# -eq 1 ]] || usage
      TASK_ID="$1"
      SPEC_PATH=""
    else
      [[ $# -eq 2 ]] || usage
      TASK_ID="$1"
      SPEC_PATH="$2"
    fi
    python3 - "${INDEX}" "${TASK_ID}" "${SPEC_PATH}" <<'PY'
import json
import pathlib
import sys

index_path, task_id, spec_path = sys.argv[1:4]

def load_json(path: pathlib.Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))

def load_index(path: pathlib.Path) -> dict:
    if not path.exists():
        return {"version": 1, "tasks": []}
    data = load_json(path)
    data.setdefault("version", 1)
    data.setdefault("tasks", [])
    return data

run = pathlib.Path("runs") / task_id
meta = load_json(run / "meta.json")
eval_path = run / "eval.json"
eval_status = "missing"
if eval_path.exists():
    eval_status = load_json(eval_path).get("status", "unknown")

existing_spec = pathlib.Path("specs") / f"{task_id}.md"
resolved_spec = spec_path or (str(existing_spec) if existing_spec.exists() else "")

entry = {
    "id": task_id,
    "mode": meta.get("mode", "unknown"),
    "status": meta.get("status", "unknown"),
    "created_at": meta.get("created_at", ""),
    "run_dir": str(run),
    "eval_status": eval_status,
}
if meta.get("ended_at"):
    entry["ended_at"] = meta["ended_at"]
if resolved_spec:
    entry["spec_path"] = resolved_spec

index = pathlib.Path(index_path)
index.parent.mkdir(parents=True, exist_ok=True)
data = load_index(index)
tasks = [item for item in data["tasks"] if item.get("id") != task_id]
tasks.append(entry)
tasks.sort(key=lambda item: (item.get("created_at", ""), item.get("id", "")))
data["tasks"] = tasks
index.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
    echo "${INDEX}"
    ;;
  list)
    STATUS_FILTER=""
    EVAL_FILTER=""
    JSON_OUTPUT=0
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --json)
          JSON_OUTPUT=1
          shift
          ;;
        --status)
          [[ $# -ge 2 ]] || usage
          STATUS_FILTER="$2"
          shift 2
          ;;
        --eval)
          [[ $# -ge 2 ]] || usage
          EVAL_FILTER="$2"
          shift 2
          ;;
        *)
          echo "error: unknown argument: $1" >&2
          usage
          ;;
      esac
    done
    python3 - "${INDEX}" "${STATUS_FILTER}" "${EVAL_FILTER}" "${JSON_OUTPUT}" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
status_filter = sys.argv[2]
eval_filter = sys.argv[3]
json_output = sys.argv[4] == "1"
if not path.exists():
    if json_output:
        print(json.dumps({"version": 1, "tasks": []}, indent=2))
    else:
        print("no tasks indexed")
    raise SystemExit(0)

data = json.loads(path.read_text(encoding="utf-8"))
tasks = data.get("tasks", [])
if status_filter:
    tasks = [task for task in tasks if task.get("status") == status_filter]
if eval_filter:
    tasks = [task for task in tasks if task.get("eval_status") == eval_filter]
if json_output:
    print(json.dumps({"version": data.get("version", 1), "tasks": tasks}, indent=2))
    raise SystemExit(0)
if not tasks:
    print("no tasks indexed")
    raise SystemExit(0)

headers = ["id", "status", "mode", "eval", "run", "spec"]
rows = [[
    item.get("id", ""),
    item.get("status", ""),
    item.get("mode", ""),
    item.get("eval_status", ""),
    item.get("run_dir", ""),
    item.get("spec_path", ""),
] for item in tasks]

widths = [
    max(len(headers[index]), *(len(row[index]) for row in rows))
    for index in range(len(headers))
]
print("  ".join(header.ljust(widths[index]) for index, header in enumerate(headers)))
print("  ".join("-" * width for width in widths))
for row in rows:
    print("  ".join(value.ljust(widths[index]) for index, value in enumerate(row)))
PY
    ;;
  rebuild)
    [[ $# -eq 0 ]] || usage
    python3 - "${INDEX}" <<'PY'
import json
import pathlib
import sys

index_path = pathlib.Path(sys.argv[1])
tasks = []

for meta_path in sorted(pathlib.Path("runs").glob("*/meta.json")):
    run = meta_path.parent
    task_id = run.name
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    eval_path = run / "eval.json"
    eval_status = "missing"
    if eval_path.exists():
        eval_status = json.loads(eval_path.read_text(encoding="utf-8")).get("status", "unknown")

    spec = pathlib.Path("specs") / f"{task_id}.md"
    entry = {
        "id": task_id,
        "mode": meta.get("mode", "unknown"),
        "status": meta.get("status", "unknown"),
        "created_at": meta.get("created_at", ""),
        "run_dir": str(run),
        "eval_status": eval_status,
    }
    if meta.get("ended_at"):
        entry["ended_at"] = meta["ended_at"]
    if spec.exists():
        entry["spec_path"] = str(spec)
    tasks.append(entry)

tasks.sort(key=lambda item: (item.get("created_at", ""), item.get("id", "")))
index_path.parent.mkdir(parents=True, exist_ok=True)
index_path.write_text(json.dumps({"version": 1, "tasks": tasks}, indent=2) + "\n", encoding="utf-8")
PY
    echo "${INDEX}"
    ;;
  *)
    echo "error: unknown command: ${COMMAND}" >&2
    usage
    ;;
esac
