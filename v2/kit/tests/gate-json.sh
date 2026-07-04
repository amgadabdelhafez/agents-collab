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

mkdir -p "${SCRATCH}/v2/kit"
ln -s "${KIT_DIR}/scripts" "${SCRATCH}/v2/kit/scripts"
ln -s "${REPO_DIR}/harness" "${SCRATCH}/harness"
cd "${SCRATCH}"

./v2/kit/scripts/task.sh gate-json-task --mode planned > /dev/null
cat > runs/gate-json-task/plan.md <<'PLAN'
# gate-json-task Plan

Exercise JSON gate output.
PLAN

./harness preflight --json > preflight.json
python3 - <<'PY'
import json
data = json.load(open("preflight.json", encoding="utf-8"))
assert data["task_id"] == "gate-json-task"
assert data["status"] == "pass"
assert data["run_dir"] == "runs/gate-json-task"
assert data["eval_status"] == "pending"
assert data["required"] == ["unit"]
PY
pass "preflight emits JSON output"

if ./harness stop-gate --json > stop-blocked.json 2> stop-blocked.err; then
  fail "stop-gate unexpectedly passed pending eval"
fi
python3 - <<'PY'
import json
data = json.load(open("stop-blocked.json", encoding="utf-8"))
assert data["task_id"] == "gate-json-task"
assert data["status"] == "blocked"
assert data["blocked"] == [{"dimension": "unit", "status": "pending"}]
PY
pass "stop-gate emits blocked JSON output"

./v2/kit/scripts/eval-dim.sh set gate-json-task unit pass --artifact artifacts/unit.log > /dev/null
./harness stop-gate --json > stop-pass.json
python3 - <<'PY'
import json
data = json.load(open("stop-pass.json", encoding="utf-8"))
assert data["task_id"] == "gate-json-task"
assert data["status"] == "pass"
assert data["required"] == ["unit"]
PY
pass "stop-gate emits passing JSON output"

echo "gate-json: all checks passed"
