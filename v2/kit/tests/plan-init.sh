#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
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
ln -s "${REPO_DIR}/v2/kit/scripts" "${SCRATCH}/v2/kit/scripts"
ln -s "${REPO_DIR}/harness" "${SCRATCH}/harness"
cd "${SCRATCH}"

./harness task planned-task --mode planned --description "Plan the described task" > /dev/null

if ./harness preflight planned-task > preflight-missing.out 2> preflight-missing.err; then
  fail "preflight unexpectedly passed before plan init"
fi
assert_contains "preflight-missing.err" "planned task missing plan"
pass "planned task starts without plan"

./harness plan --init > init.out
assert_contains "init.out" "runs/planned-task/plan.md"
assert_contains "runs/planned-task/plan.md" "# planned-task Plan"
assert_contains "runs/planned-task/plan.md" "Mode: planned"
assert_contains "runs/planned-task/plan.md" "Description: Plan the described task"
pass "plan init creates active task plan"

./harness plan > plan.out
assert_contains "plan.out" "# planned-task Plan"
assert_contains "plan.out" "Mode: planned"
pass "plan command prints initialized plan"

./harness preflight planned-task > preflight-present.out
assert_contains "preflight-present.out" "preflight passed: planned-task"
pass "initialized plan satisfies planned preflight"

if ./harness plan --init > init-again.out 2> init-again.err; then
  fail "plan init unexpectedly overwrote existing plan"
fi
assert_contains "init-again.err" "plan already exists"
pass "plan init refuses overwrite"

./harness park planned-task > /dev/null
./harness task named-task --mode maintenance > /dev/null
./harness plan --init named-task > named-init.out
assert_contains "named-init.out" "runs/named-task/plan.md"
assert_contains "runs/named-task/plan.md" "Mode: maintenance"
pass "plan init accepts explicit task id"

echo "plan-init: all checks passed"
