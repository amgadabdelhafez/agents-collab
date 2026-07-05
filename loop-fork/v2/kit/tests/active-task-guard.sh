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
  if ! grep -Fq -- "$needle" "$file"; then
    echo "---- ${file} ----" >&2
    cat "$file" >&2
    fail "expected ${file} to contain: ${needle}"
  fi
}

mkdir -p "${SCRATCH}/v2/kit"
ln -s "${REPO_DIR}/v2/kit/scripts" "${SCRATCH}/v2/kit/scripts"
ln -s "${REPO_DIR}/harness" "${SCRATCH}/harness"
cd "${SCRATCH}"

./harness task first-task > first.out
assert_contains "first.out" "runs/first-task"

if ./harness task second-task > second.out 2> second.err; then
  fail "root harness unexpectedly allowed a second active task"
fi
assert_contains "second.err" "active task already set: first-task"
assert_contains "second.err" "harness done"
pass "root task command blocks active marker overwrite"

./harness park first-task > park.out
assert_contains "park.out" "runs/first-task"
./harness task second-task > second-after-park.out
assert_contains "second-after-park.out" "runs/second-task"
assert_contains ".harness/current-task" "second-task"
pass "root task command allows creation after parking active task"

echo "active-task-guard: all checks passed"
