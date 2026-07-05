#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: preflight.sh [--json] [task-id]
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

if [[ -z "${TASK_ID}" ]]; then
  CURRENT=".harness/current-task"
  [[ -f "${CURRENT}" ]] || {
    echo "error: missing active task marker: ${CURRENT}" >&2
    exit 1
  }
  TASK_ID="$(cat "${CURRENT}")"
fi

if [[ ! "${TASK_ID}" =~ ^[a-z][a-z0-9-]*$ ]]; then
  if [[ "${JSON_OUTPUT}" -eq 1 ]]; then
    python3 - "${TASK_ID}" <<'PY'
import json
import sys
print(json.dumps({
    "task_id": sys.argv[1],
    "status": "fail",
    "error": f"task id must be kebab-case matching ^[a-z][a-z0-9-]*$: {sys.argv[1]}",
}, indent=2))
PY
    exit 2
  fi
  echo "error: task id must be kebab-case matching ^[a-z][a-z0-9-]*$: ${TASK_ID}" >&2
  exit 2
fi

RUN_DIR="runs/${TASK_ID}"
META="${RUN_DIR}/meta.json"
EVAL="${RUN_DIR}/eval.json"
MEMORY="${RUN_DIR}/memory"
PRETASK="${RUN_DIR}/artifacts/pre-task"
PLAN="${RUN_DIR}/plan.md"

fail_preflight() {
  local message="$1"
  if [[ "${JSON_OUTPUT}" -eq 1 ]]; then
    python3 - "${TASK_ID}" "${message}" <<'PY'
import json
import sys
print(json.dumps({
    "task_id": sys.argv[1],
    "status": "fail",
    "error": sys.argv[2],
}, indent=2))
PY
  else
    echo "error: ${message}" >&2
  fi
  exit 1
}

[[ -d "${RUN_DIR}" ]] || fail_preflight "missing run dir: ${RUN_DIR}"
[[ -f "${META}" ]] || fail_preflight "missing meta file: ${META}"
[[ -f "${EVAL}" ]] || fail_preflight "missing eval file: ${EVAL}"
[[ -d "${MEMORY}" ]] || fail_preflight "missing memory dir: ${MEMORY}"
if ! find "${MEMORY}" -maxdepth 1 -name '[0-9][0-9][0-9]-*.md' -type f | grep -q .; then
  fail_preflight "no memory checkpoints in ${MEMORY}"
fi

python3 - "${TASK_ID}" "${META}" "${EVAL}" "${PRETASK}" "${PLAN}" "${JSON_OUTPUT}" <<'PY'
import json
import pathlib
import re
import sys

task_id, meta_path, eval_path, pretask_dir, plan_path, json_output_arg = sys.argv[1:7]
json_output = json_output_arg == "1"
valid_statuses = {"pending", "pass", "fail", "skipped", "sign-off-granted"}
valid_overall = {"pending", "pass", "fail"}

def die(message: str) -> None:
    if json_output:
        print(json.dumps({
            "task_id": task_id,
            "status": "fail",
            "error": message,
        }, indent=2))
        raise SystemExit(1)
    raise SystemExit(f"error: {message}")

meta = json.loads(pathlib.Path(meta_path).read_text(encoding="utf-8"))
if meta.get("id") != task_id:
    die(f"meta id mismatch: {meta.get('id')} != {task_id}")
if meta.get("status") not in {"active", "done"}:
    die(f"invalid meta status: {meta.get('status')}")
if meta.get("mode") == "planned":
    plan = pathlib.Path(plan_path)
    if not plan.exists():
        die(f"planned task missing plan: {plan}")
    if not plan.read_text(encoding="utf-8").strip():
        die(f"planned task plan is empty: {plan}")

def section(text: str, heading: str) -> str:
    lines = text.splitlines()
    active = False
    collected = []
    for line in lines:
        if line.strip().lower() == heading.lower():
            active = True
            continue
        if active and line.startswith("## "):
            break
        if active:
            collected.append(line)
    return "\n".join(collected).strip()

if meta.get("research_required"):
    research = pathlib.Path(f"runs/{task_id}/research.md")
    if not research.exists():
        die(f"research required but missing: {research}")
    research_text = research.read_text(encoding="utf-8")
    placeholder_re = re.compile(r"\b(TODO|TBD|fill this|placeholder)\b", re.I)
    candidates = section(research_text, "## Candidates Reviewed")
    decision = section(research_text, "## Reuse Decision")
    sources = section(research_text, "## Sources")
    urls = re.findall(r"https?://\S+", research_text)
    if not candidates or placeholder_re.search(candidates):
        die("research must include non-placeholder Candidates Reviewed")
    if not decision or placeholder_re.search(decision):
        die("research must include a non-placeholder Reuse Decision")
    if not sources or len(urls) < 2:
        die("research must include at least two web source URLs")

eval_data = json.loads(pathlib.Path(eval_path).read_text(encoding="utf-8"))
if eval_data.get("task_id") != task_id:
    die(f"eval task id mismatch: {eval_data.get('task_id')} != {task_id}")
if eval_data.get("status") not in valid_overall:
    die(f"invalid eval overall status: {eval_data.get('status')}")

required = eval_data.get("required")
dimensions = eval_data.get("dimensions")
if not isinstance(required, list) or not all(isinstance(item, str) for item in required):
    die("eval required must be a string list")
if not isinstance(dimensions, dict):
    die("eval dimensions must be an object")

for name, record in dimensions.items():
    if not isinstance(name, str) or not name:
        die("dimension names must be non-empty strings")
    if not isinstance(record, dict):
        die(f"dimension record must be an object: {name}")
    status = record.get("status", "pending")
    if status not in valid_statuses:
        die(f"invalid dimension status for {name}: {status}")

for name in required:
    if name not in dimensions:
        die(f"required dimension missing: {name}")

pretask = pathlib.Path(pretask_dir)
if pretask.exists():
    jsonl = pretask / "state-invariants.jsonl"
    if jsonl.exists():
        for line_no, line in enumerate(jsonl.read_text(encoding="utf-8").splitlines(), start=1):
            if not line.strip():
                continue
            record = json.loads(line)
            if record.get("status") == "fail":
                die(f"state invariant failed in pre-task artifact at line {line_no}")
    log = pretask / "state-invariants.log"
    if not log.exists():
        die("pre-task artifact is missing state-invariants.log")

if json_output:
    print(json.dumps({
        "task_id": task_id,
        "status": "pass",
        "run_dir": f"runs/{task_id}",
        "eval_status": eval_data.get("status", "unknown"),
        "required": required,
    }, indent=2))
else:
    print(f"preflight passed: {task_id}")
PY
