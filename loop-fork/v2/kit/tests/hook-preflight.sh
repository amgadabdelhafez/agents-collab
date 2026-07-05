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

./v2/kit/scripts/task.sh gate-task > /dev/null

./v2/kit/scripts/preflight.sh gate-task > preflight.out
assert_contains "preflight.out" "preflight passed: gate-task"
pass "preflight accepts valid active run"

./v2/kit/scripts/task.sh planned-missing --mode planned > /dev/null
if ./v2/kit/scripts/preflight.sh planned-missing > planned-missing.out 2> planned-missing.err; then
  fail "preflight unexpectedly passed planned task without plan"
fi
assert_contains "planned-missing.err" "planned task missing plan"
pass "preflight rejects planned task without plan"

./v2/kit/scripts/task.sh planned-empty --mode planned > /dev/null
: > runs/planned-empty/plan.md
if ./v2/kit/scripts/preflight.sh planned-empty > planned-empty.out 2> planned-empty.err; then
  fail "preflight unexpectedly passed planned task with empty plan"
fi
assert_contains "planned-empty.err" "planned task plan is empty"
pass "preflight rejects planned task with empty plan"

./v2/kit/scripts/task.sh planned-present --mode planned > /dev/null
cat > runs/planned-present/plan.md <<'PLAN'
# planned-present Plan

Do the planned work.
PLAN
./v2/kit/scripts/preflight.sh planned-present > planned-present.out
assert_contains "planned-present.out" "preflight passed: planned-present"
pass "preflight accepts planned task with non-empty plan"

if ./v2/kit/scripts/preflight.sh --json planned-missing > planned-json.json 2> planned-json.err; then
  fail "JSON preflight unexpectedly passed planned task without plan"
fi
python3 - <<'PY'
import json
data = json.load(open("planned-json.json", encoding="utf-8"))
assert data["task_id"] == "planned-missing"
assert data["status"] == "fail"
assert "planned task missing plan" in data["error"]
PY
pass "preflight emits JSON error for missing planned plan"

if ./v2/kit/scripts/stop-gate.sh gate-task > gate-pending.out 2> gate-pending.err; then
  fail "stop gate unexpectedly passed pending eval"
fi
assert_contains "gate-pending.err" "blocked: unit is pending"
pass "stop gate blocks pending required dimension"

./v2/kit/scripts/eval-dim.sh set gate-task unit skipped --reason "manual skip" > /dev/null
./v2/kit/scripts/stop-gate.sh gate-task > gate-skipped.out
assert_contains "gate-skipped.out" "stop gate passed: gate-task"
pass "stop gate accepts skipped required dimension"

./v2/kit/scripts/eval-dim.sh set gate-task unit sign-off-granted --method sign-off --signed-off-by amgad > /dev/null
./v2/kit/scripts/stop-gate.sh gate-task > gate-signoff.out
assert_contains "gate-signoff.out" "stop gate passed: gate-task"
pass "stop gate accepts sign-off-granted required dimension"

./v2/kit/scripts/eval-dim.sh set gate-task unit fail --reason "unit failed" > /dev/null
if ./v2/kit/scripts/stop-gate.sh gate-task > gate-fail.out 2> gate-fail.err; then
  fail "stop gate unexpectedly passed failed eval"
fi
assert_contains "gate-fail.err" "blocked: unit is fail"
pass "stop gate blocks failed required dimension"

python3 - <<'PY'
import json
from pathlib import Path

path = Path("runs/gate-task/eval.json")
data = json.loads(path.read_text(encoding="utf-8"))
data["dimensions"]["unit"]["status"] = "bad-status"
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
if ./v2/kit/scripts/preflight.sh gate-task > bad-schema.out 2> bad-schema.err; then
  fail "preflight unexpectedly passed bad eval schema"
fi
assert_contains "bad-schema.err" "invalid dimension status"
pass "preflight rejects bad eval schema"

echo "hook-preflight: all checks passed"
