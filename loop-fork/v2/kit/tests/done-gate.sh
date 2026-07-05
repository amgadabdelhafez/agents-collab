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

./v2/kit/scripts/task.sh done-task > /dev/null

if ./v2/kit/scripts/done.sh done-task > done-pending.out 2> done-pending.err; then
  fail "done unexpectedly passed pending eval"
fi
assert_contains "done-pending.err" "blocked: unit is pending"
pass "done blocks pending required evidence"

./v2/kit/scripts/eval-dim.sh set done-task unit pass --artifact runs/done-task/artifacts/unit.log > /dev/null
if ./v2/kit/scripts/done.sh done-task > done-empty-log.out 2> done-empty-log.err; then
  fail "done unexpectedly passed empty task-log"
fi
assert_contains "done-empty-log.err" "task-log What I changed is empty"
pass "done blocks empty task-log"

python3 - <<'PY'
from pathlib import Path

Path("runs/done-task/task-log.md").write_text("""# Task done-task

## What I changed

- Completed the done gate fixture.

## Why

- Completion needs durable retrospective content.

## Notes
""", encoding="utf-8")
PY
./v2/kit/scripts/done.sh done-task > done-pass.out
assert_contains "done-pass.out" "specs/done-task.md"
assert_contains "runs/done-task/meta.json" "\"status\": \"done\""
pass "done passes after required evidence resolves"

mkdir -p post-invariants
cat > .harness/config.json <<'JSON'
{
  "pre_state_invariant_dirs": [],
  "post_state_invariant_dirs": ["post-invariants"]
}
JSON
cat > post-invariants/00-fail-post.sh <<'SH'
#!/usr/bin/env bash
echo post invariant failed
exit 9
SH
chmod +x post-invariants/00-fail-post.sh

./v2/kit/scripts/task.sh post-fail-task > /dev/null
./v2/kit/scripts/eval-dim.sh set post-fail-task unit pass --artifact runs/post-fail-task/artifacts/unit.log > /dev/null
python3 - <<'PY'
from pathlib import Path

Path("runs/post-fail-task/task-log.md").write_text("""# Task post-fail-task

## What I changed

- Completed enough work to reach post-task checks.

## Why

- Post-task invariants should block completion.

## Notes
""", encoding="utf-8")
PY
if ./v2/kit/scripts/done.sh post-fail-task > post-fail.out 2> post-fail.err; then
  fail "done unexpectedly passed failing post-task invariant"
fi
assert_contains "post-fail.err" "post-task state invariant check failed"
assert_contains "runs/post-fail-task/artifacts/post-task/00-fail-post.sh.log" "post invariant failed"
[[ ! -f specs/post-fail-task.md ]] || fail "spec was created despite failing post-task invariant"
assert_contains "runs/post-fail-task/meta.json" "\"status\": \"active\""
pass "done blocks failing post-task invariants before spec generation"

echo "done-gate: all checks passed"
