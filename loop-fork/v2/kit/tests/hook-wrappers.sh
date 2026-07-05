#!/usr/bin/env bash
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "${KIT_DIR}/../.." && pwd)"
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

mkdir -p "${SCRATCH}/v2/kit" "${SCRATCH}/.harness"
ln -s "${KIT_DIR}/scripts" "${SCRATCH}/v2/kit/scripts"
ln -s "${REPO_DIR}/.harness/hooks" "${SCRATCH}/.harness/hooks"
cd "${SCRATCH}"

./v2/kit/scripts/task.sh hook-task > /dev/null

./.harness/hooks/preflight.sh hook-task > preflight.out
assert_contains "preflight.out" "preflight passed: hook-task"
pass "preflight hook wrapper delegates to kit script"

if ./.harness/hooks/stop-gate.sh hook-task > gate-pending.out 2> gate-pending.err; then
  fail "stop-gate wrapper unexpectedly passed pending eval"
fi
assert_contains "gate-pending.err" "blocked: unit is pending"
pass "stop-gate hook wrapper blocks pending eval"

./v2/kit/scripts/eval-dim.sh set hook-task unit pass --artifact artifacts/unit.log > /dev/null
./.harness/hooks/stop-gate.sh hook-task > gate-pass.out
assert_contains "gate-pass.out" "stop gate passed: hook-task"
pass "stop-gate hook wrapper accepts passing eval"

./.harness/hooks/post-task.sh hook-task > post-task.out
assert_contains "post-task.out" "post-task state invariant check passed"
pass "post-task hook wrapper delegates to kit script"

echo "hook-wrappers: all checks passed"
