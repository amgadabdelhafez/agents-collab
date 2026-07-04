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

assert_dir() {
  [[ -d "$1" ]] || fail "missing directory: $1"
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

assert_json() {
  python3 - "$1" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as f:
    json.load(f)
PY
}

mkdir -p "${SCRATCH}/v2/kit"
ln -s "${ROOT_DIR}/scripts" "${SCRATCH}/v2/kit/scripts"
cd "${SCRATCH}"

./v2/kit/scripts/task.sh foo > task.out
assert_dir "runs/foo"
assert_dir "runs/foo/memory"
assert_dir "runs/foo/artifacts"
assert_file "runs/foo/meta.json"
assert_file "runs/foo/task-log.md"
assert_file "runs/foo/eval.json"
assert_file "runs/foo/memory/001-initial.md"
assert_file "runs/foo/artifacts/pre-task/state-invariants.log"
assert_file ".harness/current-task"
assert_contains ".harness/current-task" "foo"
assert_contains "task.out" "runs/foo"
pass "task foo creates expected files"

./v2/kit/scripts/task.sh described-task --description "Add task descriptions" > described.out
assert_contains "described.out" "runs/described-task"
assert_contains "runs/described-task/meta.json" "\"description\": \"Add task descriptions\""
assert_contains "runs/described-task/task-log.md" "Description: Add task descriptions"
printf 'foo\n' > .harness/current-task
pass "task stores optional description"

if ./v2/kit/scripts/task.sh foo > duplicate.out 2> duplicate.err; then
  fail "duplicate task unexpectedly succeeded"
fi
assert_contains "duplicate.err" "already exists"
pass "task foo fails cleanly when run already exists"

if ./v2/kit/scripts/task.sh bad_id > bad.out 2> bad.err; then
  fail "invalid task id unexpectedly succeeded"
fi
assert_contains "bad.err" "kebab-case"
pass "invalid task id fails"

./v2/kit/scripts/checkpoint.sh foo "first decision" > checkpoint.out
assert_file "runs/foo/memory/002-first-decision.md"
assert_contains "checkpoint.out" "runs/foo/memory/002-first-decision.md"
pass "checkpoint creates slugged 002 file"

for i in 1 2 3 4 5 6 7 8 9; do
  ./v2/kit/scripts/checkpoint.sh foo "extra ${i}" > /dev/null
done

python3 - <<'PY'
from pathlib import Path
names = [p.name[:3] for p in sorted(Path("runs/foo/memory").glob("*.md"))]
expected = [f"{i:03d}" for i in range(1, 12)]
if names != expected:
    raise SystemExit(f"bad memory ordering: {names} != {expected}")
PY
pass "checkpoint numbering stays lexically ordered through 011"

./v2/kit/scripts/resume.sh foo > resume.out
python3 - <<'PY'
from pathlib import Path
text = Path("resume.out").read_text()
positions = [text.index(f"===== FILE: runs/foo/memory/{i:03d}-") for i in range(1, 12)]
if positions != sorted(positions):
    raise SystemExit("resume output is not ordered")
PY
pass "resume prints memory files in order"

python3 - <<'PY'
from pathlib import Path
task_log = Path("runs/foo/task-log.md")
task_log.write_text("""# Task foo

## What I changed

- Built the foo task flow.

## Why

- Proves Phase 1 works.

## Notes

- Smoke test note.
""", encoding="utf-8")

checkpoint = Path("runs/foo/memory/011-extra-9.md")
checkpoint.write_text(checkpoint.read_text(encoding="utf-8").replace(
    "## Decided\n\n## Still open",
    "## Decided\n\n- Keep Phase 1 deterministic.\n\n## Still open\n\n- Phase 2 evidence model."
), encoding="utf-8")
PY

./v2/kit/scripts/eval-dim.sh set foo unit pass --artifact runs/foo/artifacts/unit.log > /dev/null
./v2/kit/scripts/done.sh foo > done.out
assert_file "specs/foo.md"
assert_contains "specs/foo.md" "## What was built"
assert_contains "specs/foo.md" "Built the foo task flow."
assert_contains "specs/foo.md" "Keep Phase 1 deterministic."
assert_contains "specs/foo.md" "Phase 2 evidence model."
assert_contains "specs/foo.md" "011 - extra 9"
[[ ! -e ".harness/current-task" ]] || fail ".harness/current-task was not removed"
pass "done creates retrospective spec and clears current task"

assert_json "runs/foo/meta.json"
assert_json "runs/foo/eval.json"
python3 - <<'PY'
import json
data = json.load(open("runs/foo/eval.json", encoding="utf-8"))
assert "required" in data
assert "dimensions" in data
assert data["dimensions"]["unit"]["status"] == "pass"
PY
pass "JSON files parse"

echo "smoke: all checks passed"
