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

./v2/kit/scripts/task.sh park-task > /dev/null
./v2/kit/scripts/park.sh park-task > park.out
assert_contains "park.out" "runs/park-task"
[[ ! -e ".harness/current-task" ]] || fail "current task marker should be cleared"
assert_contains "runs/park-task/meta.json" "\"status\": \"parked\""
python3 - <<'PY'
import json
data = json.load(open(".harness/tasks.json", encoding="utf-8"))
task = data["tasks"][0]
assert task["id"] == "park-task"
assert task["status"] == "parked"
PY
./v2/kit/scripts/tasks-index.sh list --status parked > parked-list.out
assert_contains "parked-list.out" "park-task"
assert_contains "parked-list.out" "parked"
pass "park clears current task and indexes parked status"

./v2/kit/scripts/activate.sh park-task > activate.out
assert_contains "activate.out" "runs/park-task"
assert_contains ".harness/current-task" "park-task"
assert_contains "runs/park-task/meta.json" "\"status\": \"active\""
python3 - <<'PY'
import json
data = json.load(open(".harness/tasks.json", encoding="utf-8"))
task = data["tasks"][0]
assert task["id"] == "park-task"
assert task["status"] == "active"
PY
pass "activate restores current task and indexes active status"

./v2/kit/scripts/eval-dim.sh set park-task unit pass --artifact runs/park-task/artifacts/unit.log > /dev/null
python3 - <<'PY'
from pathlib import Path

Path("runs/park-task/task-log.md").write_text("""# Task park-task

## What I changed

- Completed the park activate fixture.

## Why

- Activate should reject completed tasks.

## Notes
""", encoding="utf-8")
PY
./v2/kit/scripts/done.sh park-task > /dev/null
if ./v2/kit/scripts/activate.sh park-task > activate-done.out 2> activate-done.err; then
  fail "activate unexpectedly passed completed task"
fi
assert_contains "activate-done.err" "cannot activate completed task"
pass "activate blocks completed tasks"

echo "park-activate: all checks passed"
