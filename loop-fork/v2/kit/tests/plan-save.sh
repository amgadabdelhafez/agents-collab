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

mkdir -p "${SCRATCH}/v2/kit" "${SCRATCH}/.harness/hooks"
ln -s "${REPO_DIR}/v2/kit/scripts" "${SCRATCH}/v2/kit/scripts"
ln -s "${REPO_DIR}/harness" "${SCRATCH}/harness"
ln -s "${REPO_DIR}/.harness/hooks/on-plan-exit.sh" "${SCRATCH}/.harness/hooks/on-plan-exit.sh"
cd "${SCRATCH}"

./harness task planned-task --mode planned > /dev/null
printf '## Objective\n\nPersist this plan from stdin.\n' | ./harness plan --save > save.out
assert_contains "save.out" "runs/planned-task/plan.md"
assert_contains "runs/planned-task/plan.md" "Persist this plan from stdin"
./harness preflight planned-task > preflight.out
assert_contains "preflight.out" "preflight passed: planned-task"
pass "plan save persists stdin content and satisfies planned preflight"

cat > next-plan.md <<'PLAN'
# Planned Task Updated

## Objective

Persist this plan from a hook file.
PLAN
./.harness/hooks/on-plan-exit.sh planned-task --file next-plan.md > hook.out
assert_contains "hook.out" "runs/planned-task/plan.md"
assert_contains "runs/planned-task/plan.md" "Persist this plan from a hook file"
pass "plan-exit hook saves plan file content"

HARNESS_PLAN_TEXT='## Objective

Persist this plan from environment.' ./v2/kit/scripts/plan-save.sh planned-task > env.out
assert_contains "runs/planned-task/plan.md" "Persist this plan from environment"
pass "plan save supports HARNESS_PLAN_TEXT"

echo "plan-save: all checks passed"
