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

./harness help > help.out
assert_contains "help.out" "status [--json]"
assert_contains "help.out" "plan [--init|--save] [--file <path>] [task-id]"
assert_contains "help.out" "list [--json] [--status <status>] [--eval <status>]"
assert_contains "help.out" "--research-required"
assert_contains "help.out" "research --init|--save|--status|--gate [task-id]"
assert_contains "help.out" "session-export [args...]"
assert_contains "help.out" "loop-prompt <slug> --slice <text>"
assert_contains "help.out" "park \"<idea>\" [--name <slug>]"
assert_contains "help.out" "park-idea \"<idea>\" [--name <slug>]"
assert_contains "help.out" "promote <slug|spec>"
assert_contains "help.out" "retrospect [args...]"
assert_contains "help.out" "preflight [--json] [task-id]"
assert_contains "help.out" "stop-gate [--json] [task-id]"
pass "help output documents JSON, filter, and research flags"

if ./v2/kit/scripts/tasks-index.sh > index-usage.out 2> index-usage.err; then
  fail "tasks-index unexpectedly passed without command"
fi
assert_contains "index-usage.err" "--status active|parked|done"
pass "tasks-index usage documents parked status"

echo "cli-help: all checks passed"
