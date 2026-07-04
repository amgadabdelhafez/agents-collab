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

mkdir -p "${SCRATCH}/v2/kit"
ln -s "${ROOT_DIR}/scripts" "${SCRATCH}/v2/kit/scripts"
cd "${SCRATCH}"

./v2/kit/scripts/eval-dim.sh init eval-task --required unit,live,human > /dev/null
python3 - <<'PY'
import json
data = json.load(open("runs/eval-task/eval.json", encoding="utf-8"))
assert data["status"] == "pending"
assert data["required"] == ["unit", "live", "human"]
assert data["dimensions"]["unit"]["status"] == "pending"
PY
pass "init writes required dimensions"

./v2/kit/scripts/eval-dim.sh set eval-task unit pass --artifact artifacts/unit.log > /dev/null
[[ "$(./v2/kit/scripts/eval-dim.sh aggregate eval-task)" == "pending" ]] || fail "aggregate should be pending"
pass "aggregate remains pending until all required dimensions resolve"

./v2/kit/scripts/eval-dim.sh set eval-task live skipped --reason "no live rig" > /dev/null
./v2/kit/scripts/eval-dim.sh set eval-task human sign-off-granted --method sign-off --signed-off-by amgad > /dev/null
[[ "$(./v2/kit/scripts/eval-dim.sh aggregate eval-task)" == "pass" ]] || fail "aggregate should pass"
python3 - <<'PY'
import json
data = json.load(open("runs/eval-task/eval.json", encoding="utf-8"))
assert data["status"] == "pass"
assert data["dimensions"]["live"]["reason"] == "no live rig"
assert data["dimensions"]["human"]["signed_off_by"] == "amgad"
PY
pass "skipped and sign-off-granted satisfy required dimensions"

./v2/kit/scripts/eval-dim.sh set eval-task unit fail --reason "unit test failed" > /dev/null
[[ "$(./v2/kit/scripts/eval-dim.sh aggregate eval-task)" == "fail" ]] || fail "aggregate should fail"
pass "failed required dimension fails aggregate"

echo "eval-dimensions: all checks passed"
