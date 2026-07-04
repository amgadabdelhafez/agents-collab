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

./harness task active-task > /dev/null
./harness park "palette jitters when switching direction within cooldown" --name palette-jitter > idea.out
assert_contains "idea.out" "Parked: specs/palette-jitter.md"
assert_contains ".harness/current-task" "active-task"
assert_contains "specs/palette-jitter.md" "palette jitters when switching direction within cooldown"
assert_contains "specs/palette-jitter.md" "Active task: active-task"
assert_contains ".harness/parked-ideas.jsonl" "\"id\": \"palette-jitter\""
pass "park captures an idea without interrupting current task"

./harness park active-task > task-park.out
assert_contains "task-park.out" "runs/active-task"
[[ ! -e ".harness/current-task" ]] || fail "current task marker should be cleared after task park"
pass "park still parks existing tasks"

./harness promote palette-jitter --mode planned > promote.out
assert_contains "promote.out" "Created runs/palette-jitter, mode=planned"
assert_contains ".harness/current-task" "palette-jitter"
assert_contains "runs/palette-jitter/meta.json" "\"promoted_from\": \"specs/palette-jitter.md\""
assert_contains "runs/palette-jitter/parked-idea.md" "palette jitters when switching direction within cooldown"
assert_contains "runs/palette-jitter/memory/002-promoted-parked-idea.md" "Promoted parked idea"
assert_contains ".harness/parked-ideas.jsonl" "\"status\": \"promoted\""
pass "promote turns a parked idea into an active task"

echo "idea-capture: all checks passed"
