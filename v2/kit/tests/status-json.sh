#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
KIT_DIR="${REPO_DIR}/v2/kit"
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
ln -s "${KIT_DIR}/scripts" "${SCRATCH}/v2/kit/scripts"
ln -s "${REPO_DIR}/harness" "${SCRATCH}/harness"
cd "${SCRATCH}"

./v2/kit/scripts/task.sh status-task --mode planned > /dev/null
cat > runs/status-task/plan.md <<'PLAN'
# status-task Plan
PLAN

./harness status > status.txt
assert_contains "status.txt" "active_task: status-task"
assert_contains "status.txt" "plan: runs/status-task/plan.md"
pass "status preserves human output"

./harness status --json > status.json
python3 - <<'PY'
import json
data = json.load(open("status.json", encoding="utf-8"))
assert data["active_task"] == "status-task"
assert data["run_dir"] == "runs/status-task"
assert data["meta"]["id"] == "status-task"
assert data["meta"]["mode"] == "planned"
assert data["meta"]["status"] == "active"
assert data["plan"] == "runs/status-task/plan.md"
assert data["latest_memory"] == "runs/status-task/memory/001-initial.md"
assert data["eval_status"] == "pending"
PY
pass "status emits JSON output"

rm -f .harness/current-task
./harness status --json > idle-status.json
python3 - <<'PY'
import json
data = json.load(open("idle-status.json", encoding="utf-8"))
assert data["active_task"] is None
assert data["run_dir"] is None
assert data["meta"] is None
assert data["plan"] is None
assert data["latest_memory"] is None
assert data["eval_status"] is None
PY
pass "status emits idle JSON output without active marker"

echo "status-json: all checks passed"
