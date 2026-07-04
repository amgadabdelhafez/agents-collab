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

./harness task day-session-view --mode planned --description "Exercise loop prompt helper" > /dev/null
./harness plan --init > /dev/null

./harness loop-prompt 02-gap-classifier \
  --slice "Implement only Proposed Task 2: Backend gap classifier rewrite." \
  --test-command "pytest tests/test_gap_classifier.py tests/test_working_hours.py" \
  --proof "Update task-log and checkpoint before stopping." > loop.out

PROMPT="runs/day-session-view/loop-slices/02-gap-classifier.md"
[[ -f "${PROMPT}" ]] || fail "missing loop prompt file"
assert_contains "loop.out" "${PROMPT}"
assert_contains "loop.out" "loop --tmux --agent claude --review codex --review-plan none"
assert_contains "${PROMPT}" "Do not pass equivalent plain text"
assert_contains "${PROMPT}" "Canonical Harness plan: \`runs/day-session-view/plan.md\`"
assert_contains "${PROMPT}" "Implement only Proposed Task 2"
assert_contains "${PROMPT}" "Do not create, replace, or rely on root \`PLAN.md\`"
assert_contains "${PROMPT}" "Do not run \`./harness done\`"
assert_contains "${PROMPT}" "./harness verify unit -- pytest tests/test_gap_classifier.py tests/test_working_hours.py"
assert_contains "${PROMPT}" "If this slice changes cached or schema-versioned payloads"
pass "loop-prompt creates loop-safe slice prompt"

mkdir -p venv/bin src
cat > venv/bin/python <<'SH'
#!/usr/bin/env sh
exit 0
SH
chmod +x venv/bin/python
cat > src/session_analytics.py <<'PY'
SESSION_DETAIL_VERSION = 1
PY

./harness loop-prompt 03-session-type \
  --slice "Implement only Proposed Task 4: Backend session type classifier." \
  --test-command "pytest tests/test_session_type_classifier.py -q" > venv.out
VENV_PROMPT="runs/day-session-view/loop-slices/03-session-type.md"
assert_contains "${VENV_PROMPT}" "./harness verify unit -- venv/bin/python -m pytest tests/test_session_type_classifier.py -q"
assert_contains "${VENV_PROMPT}" "This repo defines \`SESSION_DETAIL_VERSION\`"
pass "loop-prompt normalizes pytest through venv and flags session detail cache version"

if ./harness loop-prompt 02-gap-classifier --slice "again" > overwrite.out 2> overwrite.err; then
  fail "loop-prompt overwrote an existing prompt without --force"
fi
assert_contains "overwrite.err" "loop prompt already exists"
pass "loop-prompt refuses accidental overwrite"

./harness loop-prompt final-slice \
  --slice "Finish the whole parent task." \
  --allow-done \
  --force > allow.out
assert_contains "runs/day-session-view/loop-slices/final-slice.md" "Run \`./harness done\` only after the full active Harness task is complete"
pass "loop-prompt can explicitly allow done"

echo "loop-prompt: all checks passed"
