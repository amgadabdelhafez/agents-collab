#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH}"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

assert_file() {
  [[ -f "$1" ]] || fail "missing file: $1"
}

assert_contains() {
  local file="$1"
  local needle="$2"
  if ! grep -Fq "$needle" "$file"; then
    echo "---- ${file} ----" >&2
    cat "$file" >&2
    fail "expected ${file} to contain: ${needle}"
  fi
}

mkdir -p "${SCRATCH}/v2/kit"
ln -s "${ROOT_DIR}/scripts" "${SCRATCH}/v2/kit/scripts"
cd "${SCRATCH}"

./v2/kit/scripts/task.sh indexed-task --mode planned > /dev/null
cat > runs/indexed-task/plan.md <<'PLAN'
# indexed-task Plan

Exercise lifecycle indexing.
PLAN
assert_file ".harness/tasks.json"
python3 - <<'PY'
import json
data = json.load(open(".harness/tasks.json", encoding="utf-8"))
assert data["version"] == 1
tasks = data["tasks"]
assert len(tasks) == 1
task = tasks[0]
assert task["id"] == "indexed-task"
assert task["mode"] == "planned"
assert task["status"] == "active"
assert task["run_dir"] == "runs/indexed-task"
assert task["eval_status"] == "pending"
PY
pass "task creation indexes active task"

./v2/kit/scripts/eval-dim.sh set indexed-task unit pass --artifact runs/indexed-task/artifacts/unit.log > /dev/null
python3 - <<'PY'
from pathlib import Path

task_log = Path("runs/indexed-task/task-log.md")
task_log.write_text("""# Task indexed-task

## What I changed

- Tested lifecycle index.

## Why

- Coordination needs a compact task list.

## Notes
""", encoding="utf-8")

memory = Path("runs/indexed-task/memory/001-initial.md")
memory.write_text(memory.read_text(encoding="utf-8").replace(
    "## Decided\n\n## Still open",
    "## Decided\n\n- Use .harness/tasks.json as the canonical index.\n\n## Still open"
), encoding="utf-8")
PY

./v2/kit/scripts/done.sh indexed-task > done.out
assert_contains "done.out" "specs/indexed-task.md"
python3 - <<'PY'
import json
data = json.load(open(".harness/tasks.json", encoding="utf-8"))
tasks = data["tasks"]
assert len(tasks) == 1
task = tasks[0]
assert task["id"] == "indexed-task"
assert task["status"] == "done"
assert task["eval_status"] == "pass"
assert task["spec_path"] == "specs/indexed-task.md"
assert task["ended_at"]
PY
pass "task completion updates index"

./v2/kit/scripts/tasks-index.sh list > list.out
assert_contains "list.out" "indexed-task"
assert_contains "list.out" "done"
assert_contains "list.out" "pass"
assert_contains "list.out" "specs/indexed-task.md"
pass "list prints indexed tasks"

./v2/kit/scripts/task.sh second-task --mode emergent > /dev/null
./v2/kit/scripts/tasks-index.sh rebuild > rebuild.out
assert_contains "rebuild.out" ".harness/tasks.json"
python3 - <<'PY'
import json
data = json.load(open(".harness/tasks.json", encoding="utf-8"))
by_id = {task["id"]: task for task in data["tasks"]}
assert by_id["indexed-task"]["status"] == "done"
assert by_id["indexed-task"]["spec_path"] == "specs/indexed-task.md"
assert by_id["second-task"]["status"] == "active"
assert by_id["second-task"]["eval_status"] == "pending"
PY
pass "rebuild backfills completed and active tasks"

./v2/kit/scripts/tasks-index.sh list --status active > list-active.out
assert_contains "list-active.out" "second-task"
if grep -Fq "indexed-task" list-active.out; then
  fail "active filter included done task"
fi

./v2/kit/scripts/tasks-index.sh list --eval pass > list-pass.out
assert_contains "list-pass.out" "indexed-task"
if grep -Fq "second-task" list-pass.out; then
  fail "eval filter included pending task"
fi
pass "list filters by lifecycle and eval status"

./v2/kit/scripts/tasks-index.sh list --json --status active > list-active.json
python3 - <<'PY'
import json
data = json.load(open("list-active.json", encoding="utf-8"))
assert data["version"] == 1
tasks = data["tasks"]
assert len(tasks) == 1
assert tasks[0]["id"] == "second-task"
assert tasks[0]["status"] == "active"
assert tasks[0]["eval_status"] == "pending"
PY
pass "list emits filtered JSON output"

echo "coordination-lite: all checks passed"
