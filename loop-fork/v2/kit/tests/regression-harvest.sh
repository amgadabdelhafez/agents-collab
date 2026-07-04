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
  if ! grep -Fq -- "$needle" "$file"; then
    echo "---- ${file} ----" >&2
    cat "$file" >&2
    fail "expected ${file} to contain: ${needle}"
  fi
}

mkdir -p "${SCRATCH}/v2/kit" "${SCRATCH}/tests"
ln -s "${ROOT_DIR}/scripts" "${SCRATCH}/v2/kit/scripts"
cd "${SCRATCH}"

./v2/kit/scripts/task.sh blink-per-frame > /dev/null
cat > tests/test_blink.py <<'PY'
def test_blink_once_per_dwell():
    assert True
PY
./v2/kit/scripts/eval-dim.sh set blink-per-frame unit pass --artifact tests/test_blink.py > /dev/null
python3 - <<'PY'
from pathlib import Path

Path("runs/blink-per-frame/task-log.md").write_text("""# Task blink-per-frame

## What I changed

- Fixed the blink-per-frame bug where the blink counter advanced once per frame.
- Added tests/test_blink.py regression test to guard blink once per dwell.

## Why

- Failure symptom: users triggered multiple blinks in a single dwell.

## Notes

- Regression guard should stay tied to the unit dimension.
""", encoding="utf-8")
PY

./v2/kit/scripts/done.sh blink-per-frame > done.out 2> done.err
assert_contains "done.out" "specs/blink-per-frame.md"
assert_contains "done.err" "regression harvest created: evals/regression/blink-per-frame.md"
assert_contains "evals/regression/blink-per-frame.md" "Failure symptom: users triggered multiple blinks"
assert_contains "evals/regression/blink-per-frame.md" "tests/test_blink.py"
assert_contains "runs/blink-per-frame/artifacts/regression-harvest/harvest.json" "\"status\": \"created\""
pass "post-task regression harvest creates draft eval for bug-fix task"

./v2/kit/scripts/task.sh structured-regression > /dev/null
./v2/kit/scripts/eval-dim.sh set structured-regression unit pass --artifact tests/test_blink.py > /dev/null
python3 - <<'PY'
from pathlib import Path

Path("runs/structured-regression/task-log.md").write_text("""# Task structured-regression

Regression: yes
Regression id: dwell-repeat
Regression symptom: Dwell blink repeated after one gaze event.
Regression guard: tests/test_blink.py::test_blink_once_per_dwell

## What I changed

- Updated timing logic and dwell accounting.

## Why

- The structured marker should be enough to draft a regression check.

## Notes
""", encoding="utf-8")
PY

./v2/kit/scripts/done.sh structured-regression > structured.out 2> structured.err
assert_contains "structured.err" "regression harvest created: evals/regression/dwell-repeat.md"
assert_contains "evals/regression/dwell-repeat.md" "Dwell blink repeated after one gaze event"
assert_contains "evals/regression/dwell-repeat.md" "tests/test_blink.py::test_blink_once_per_dwell"
assert_contains "runs/structured-regression/artifacts/regression-harvest/harvest.json" "\"id\""
pass "structured regression markers create draft eval without heuristic wording"

./v2/kit/scripts/task.sh explicit-no-regression > /dev/null
./v2/kit/scripts/eval-dim.sh set explicit-no-regression unit pass --artifact tests/test_blink.py > /dev/null
python3 - <<'PY'
from pathlib import Path

Path("runs/explicit-no-regression/task-log.md").write_text("""# Task explicit-no-regression

Regression: no

## What I changed

- Fixed documentation around bug-fix examples and regression wording.

## Why

- This is intentionally meta tooling work.

## Notes
""", encoding="utf-8")
PY

./v2/kit/scripts/done.sh explicit-no-regression > explicit-no.out 2> explicit-no.err
assert_contains "explicit-no.err" "regression harvest skipped: no bug-fix signal"
[[ ! -f "evals/regression/explicit-no-regression.md" ]] || fail "Regression: no created a regression draft"
pass "explicit Regression no marker suppresses heuristic wording"

./v2/kit/scripts/task.sh slash-meta-discussion > /dev/null
./v2/kit/scripts/eval-dim.sh set slash-meta-discussion unit pass --artifact tests/test_blink.py > /dev/null
python3 - <<'PY'
from pathlib import Path

Path("runs/slash-meta-discussion/task-log.md").write_text("""# Task slash-meta-discussion

## What I changed

- Documented heuristic bug/fix wording and regression marker examples.

## Why

- This is meta tooling work, not a product bug fix.

## Notes
""", encoding="utf-8")
PY

./v2/kit/scripts/done.sh slash-meta-discussion > slash-meta.out 2> slash-meta.err
assert_contains "slash-meta.err" "regression harvest skipped: no bug-fix signal"
[[ ! -f "evals/regression/slash-meta-discussion.md" ]] || fail "bug/fix meta wording created a regression draft"
pass "regression harvest ignores slash-separated bug/fix meta wording"

./v2/kit/scripts/task.sh meta-discussion > /dev/null
./v2/kit/scripts/eval-dim.sh set meta-discussion unit pass --artifact tests/test_blink.py > /dev/null
python3 - <<'PY'
from pathlib import Path

Path("runs/meta-discussion/task-log.md").write_text("""# Task meta-discussion

## What I changed

- Added documentation about bug-fix task logs and regression-harvest behavior.
- Added examples like `Fixed the blink-per-frame bug` to explain detection.

## Why

- This is meta tooling work, not an actual product bug fix.

## Notes
""", encoding="utf-8")
PY

./v2/kit/scripts/done.sh meta-discussion > meta.out 2> meta.err
assert_contains "meta.err" "regression harvest skipped: no bug-fix signal"
[[ ! -f "evals/regression/meta-discussion.md" ]] || fail "meta bug-fix phrasing created a regression draft"
pass "regression harvest ignores meta bug-fix phrasing"

echo "regression-harvest: all checks passed"
