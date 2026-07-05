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
  if ! grep -Fq -- "$needle" "$file"; then
    echo "---- ${file} ----" >&2
    cat "$file" >&2
    fail "expected ${file} to contain: ${needle}"
  fi
}

mkdir -p "${SCRATCH}/v2/kit"
ln -s "${ROOT_DIR}/scripts" "${SCRATCH}/v2/kit/scripts"
cd "${SCRATCH}"

./v2/kit/scripts/task.sh research-task --mode investigation > /dev/null
assert_file "runs/research-task/notes.md"
assert_contains "runs/research-task/notes.md" "# Investigation research-task"
python3 - <<'PY'
import json
data = json.load(open("runs/research-task/eval.json", encoding="utf-8"))
assert data["status"] == "pass"
assert data["required"] == []
assert data["dimensions"] == {}
PY
pass "investigation task initializes notes and no required eval"

./v2/kit/scripts/preflight.sh research-task > preflight.out
assert_contains "preflight.out" "preflight passed: research-task"
./v2/kit/scripts/stop-gate.sh research-task > stop-gate.out
assert_contains "stop-gate.out" "stop gate passed: research-task"
pass "investigation task passes gates without unit evidence"

./v2/kit/scripts/task.sh normal-task > /dev/null
[[ ! -e "runs/normal-task/notes.md" ]] || fail "normal task should not create notes.md"
python3 - <<'PY'
import json
data = json.load(open("runs/normal-task/eval.json", encoding="utf-8"))
assert data["status"] == "pending"
assert data["required"] == ["unit"]
assert data["dimensions"]["unit"]["status"] == "pending"
PY
pass "non-investigation task keeps unit eval default"

echo "mode-init: all checks passed"
