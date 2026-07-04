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

mkdir -p "${SCRATCH}/v2/kit" "${SCRATCH}/.harness" "${SCRATCH}/src"
ln -s "${ROOT_DIR}/scripts" "${SCRATCH}/v2/kit/scripts"
cd "${SCRATCH}"

cat > .harness/config.json <<'JSON'
{
  "debt_loc_growth_threshold": 3,
  "debt_scan_paths": ["src"],
  "debt_file_extensions": [".py"]
}
JSON

cat > src/eye_switch.py <<'PY'
print("start")
print("ready")
PY

./v2/kit/scripts/task.sh debt-task > /dev/null

cat >> src/eye_switch.py <<'PY'
print("one")
print("two")
print("three")
print("four")
PY

./v2/kit/scripts/eval-dim.sh set debt-task unit pass --artifact runs/debt-task/artifacts/unit.log > /dev/null
python3 - <<'PY'
from pathlib import Path

Path("runs/debt-task/task-log.md").write_text("""# Task debt-task

## What I changed

- Grew the fixture file enough to trigger LOC debt detection.

## Why

- The post-task scan should append a non-blocking debt register row.

## Notes
""", encoding="utf-8")
PY

./v2/kit/scripts/done.sh debt-task > done.out 2> done.err
assert_contains "done.out" "specs/debt-task.md"
assert_contains "done.err" "debt scan completed: 1 finding(s), 1 appended"
assert_contains "debt/register.jsonl" "\"signal\": \"loc_growth\""
assert_contains "debt/register.jsonl" "\"file\": \"src/eye_switch.py\""
python3 - <<'PY'
import json
from pathlib import Path

rows = [json.loads(line) for line in Path("debt/register.jsonl").read_text(encoding="utf-8").splitlines()]
row = rows[0]
assert row["task_id"] == "debt-task"
assert row["before_loc"] == 2
assert row["after_loc"] == 6
assert row["delta_loc"] == 4
assert row["threshold"] == 3

scan = json.loads(Path("runs/debt-task/artifacts/debt/scan.json").read_text(encoding="utf-8"))
assert scan["findings"][0]["file"] == "src/eye_switch.py"
PY
pass "post-task debt scan appends LOC growth row without blocking done"

cat > .harness/config.json <<'JSON'
{
  "debt_loc_growth_threshold": 2,
  "debt_file_extensions": [".py"]
}
JSON

mkdir -p vendor reports src
cat > src/policy.py <<'PY'
print("policy")
PY
cat > vendor/generated.py <<'PY'
print("vendor one")
print("vendor two")
PY
cat > reports/generated.py <<'PY'
print("report one")
print("report two")
PY

./v2/kit/scripts/task.sh policy-task > /dev/null
python3 - <<'PY'
import json
from pathlib import Path

baseline = json.loads(Path("runs/policy-task/artifacts/debt/baseline-loc.json").read_text(encoding="utf-8"))
files = baseline["files"]
assert "src/policy.py" in files
assert "vendor/generated.py" not in files
assert "reports/generated.py" not in files
PY

cat >> src/policy.py <<'PY'
print("policy two")
print("policy three")
PY
cat >> vendor/generated.py <<'PY'
print("vendor three")
print("vendor four")
print("vendor five")
PY

./v2/kit/scripts/eval-dim.sh set policy-task unit pass --artifact runs/policy-task/artifacts/unit.log > /dev/null
python3 - <<'PY'
from pathlib import Path

Path("runs/policy-task/task-log.md").write_text("""# Task policy-task

## What I changed

- Grew source and vendored files to test default debt policy.

## Why

- The default scan should include source roots and avoid out-of-scope paths.

## Notes
""", encoding="utf-8")
PY
./v2/kit/scripts/done.sh policy-task > policy-done.out 2> policy-done.err
assert_contains "policy-done.err" "debt scan completed: 1 finding(s), 1 appended"
assert_contains "debt/register.jsonl" "\"file\": \"src/policy.py\""
if grep -Fq "vendor/generated.py" debt/register.jsonl; then
  fail "default debt policy should not register vendored files"
fi
pass "default debt policy scans source roots and excludes out-of-scope paths"

echo "debt-scan: all checks passed"
