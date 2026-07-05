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

./v2/kit/scripts/task.sh guard-task > /dev/null

mkdir -p ".harness/locks/checkpoint-guard-task.lock"
if ./v2/kit/scripts/checkpoint.sh guard-task "blocked checkpoint" > checkpoint-blocked.out 2> checkpoint-blocked.err; then
  fail "checkpoint unexpectedly passed with held lock"
fi
assert_contains "checkpoint-blocked.err" "lock exists: .harness/locks/checkpoint-guard-task.lock"
rm -rf ".harness/locks/checkpoint-guard-task.lock"
pass "checkpoint fails clearly when lock exists"

./v2/kit/scripts/checkpoint.sh guard-task "first guarded checkpoint" > /dev/null
./v2/kit/scripts/checkpoint.sh guard-task "second guarded checkpoint" > /dev/null
assert_file "runs/guard-task/memory/002-first-guarded-checkpoint.md"
assert_file "runs/guard-task/memory/003-second-guarded-checkpoint.md"
pass "checkpoint lock preserves sequential allocation"

mkdir -p ".harness/locks/verify-guard-task-unit.lock"
if ./v2/kit/scripts/verify.sh guard-task unit -- sh -c 'echo blocked' > verify-blocked.out 2> verify-blocked.err; then
  fail "verify unexpectedly passed with held lock"
fi
assert_contains "verify-blocked.err" "lock exists: .harness/locks/verify-guard-task-unit.lock"
rm -rf ".harness/locks/verify-guard-task-unit.lock"
pass "verify fails clearly when lock exists"

./v2/kit/scripts/verify.sh guard-task unit -- sh -c 'echo attempt one' > /dev/null
./v2/kit/scripts/verify.sh guard-task unit -- sh -c 'echo attempt two' > /dev/null
assert_file "runs/guard-task/artifacts/unit/attempt-001.log"
assert_file "runs/guard-task/artifacts/unit/attempt-002.log"
assert_contains "runs/guard-task/artifacts/unit/attempt-001.log" "attempt one"
assert_contains "runs/guard-task/artifacts/unit/attempt-002.log" "attempt two"
python3 - <<'PY'
import json
data = json.load(open("runs/guard-task/eval.json", encoding="utf-8"))
unit = data["dimensions"]["unit"]
assert data["status"] == "pass"
assert unit["latest_attempt"] == "002"
assert unit["latest_attempt_artifact"] == "runs/guard-task/artifacts/unit/attempt-002.log"
PY
pass "verify lock preserves sequential attempt allocation"

echo "parallel-guards: all checks passed"
