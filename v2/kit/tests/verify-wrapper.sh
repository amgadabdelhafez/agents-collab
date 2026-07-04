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

./v2/kit/scripts/task.sh verify-task > /dev/null
./v2/kit/scripts/verify.sh verify-task unit -- sh -c 'echo passing command' > pass.out
assert_contains "pass.out" "runs/verify-task/artifacts/unit/verify.log"
assert_file "runs/verify-task/artifacts/unit/verify.log"
assert_file "runs/verify-task/artifacts/unit/verify.json"
assert_file "runs/verify-task/artifacts/unit/attempt-001.log"
assert_file "runs/verify-task/artifacts/unit/attempt-001.json"
assert_contains "runs/verify-task/artifacts/unit/verify.log" "passing command"
assert_contains "runs/verify-task/artifacts/unit/verify.log" "attempt: 001"
assert_contains "runs/verify-task/artifacts/unit/verify.log" "exit_code: 0"
python3 - <<'PY'
import json
data = json.load(open("runs/verify-task/eval.json", encoding="utf-8"))
assert data["status"] == "pass"
assert data["required"] == ["unit"]
assert data["dimensions"]["unit"]["status"] == "pass"
assert data["dimensions"]["unit"]["method"] == "verify.sh"
assert data["dimensions"]["unit"]["artifact"] == "runs/verify-task/artifacts/unit/verify.log"
assert data["dimensions"]["unit"]["latest_attempt"] == "001"
assert data["dimensions"]["unit"]["latest_attempt_artifact"] == "runs/verify-task/artifacts/unit/attempt-001.log"
meta = json.load(open("runs/verify-task/artifacts/unit/verify.json", encoding="utf-8"))
assert meta["status"] == "pass"
assert meta["exit_code"] == 0
assert meta["attempt"] == "001"
PY
pass "passing command records artifact and passes dimension"

./v2/kit/scripts/verify.sh verify-task unit -- sh -c 'printf "%s\n" "lint: skipped" "unit: passed"' > mixed.out
assert_contains "mixed.out" "runs/verify-task/artifacts/unit/verify.log"
assert_file "runs/verify-task/artifacts/unit/attempt-002.log"
assert_file "runs/verify-task/artifacts/unit/attempt-002.json"
assert_contains "runs/verify-task/artifacts/unit/attempt-002.log" "lint: skipped"
assert_contains "runs/verify-task/artifacts/unit/attempt-002.log" "unit: passed"
python3 - <<'PY'
import json
data = json.load(open("runs/verify-task/eval.json", encoding="utf-8"))
assert data["status"] == "pass"
assert data["required"] == ["unit"]
assert data["dimensions"]["unit"]["status"] == "pass"
assert data["dimensions"]["unit"]["latest_attempt"] == "002"
meta = json.load(open("runs/verify-task/artifacts/unit/verify.json", encoding="utf-8"))
assert meta["status"] == "pass"
assert meta["exit_code"] == 0
assert meta["command_exit_code"] == 0
assert meta["attempt"] == "002"
PY
pass "mixed skipped and passing checks still pass verification"

if ./v2/kit/scripts/verify.sh verify-task unit -- sh -c 'printf "%s\n" "lint: skipped" "typecheck: skipped" "unit: skipped" "integration: skipped" "ui: skipped"' > skip-only.out 2> skip-only.err; then
  fail "skip-only command unexpectedly passed"
fi
assert_contains "skip-only.out" "runs/verify-task/artifacts/unit/verify.log"
assert_file "runs/verify-task/artifacts/unit/attempt-003.log"
assert_file "runs/verify-task/artifacts/unit/attempt-003.json"
assert_contains "runs/verify-task/artifacts/unit/attempt-003.log" "lint: skipped"
assert_contains "runs/verify-task/artifacts/unit/attempt-003.log" "verify_guard: skip-only verification command"
assert_contains "runs/verify-task/artifacts/unit/attempt-003.log" "command_exit_code: 0"
assert_contains "runs/verify-task/artifacts/unit/attempt-003.log" "exit_code: 1"
python3 - <<'PY'
import json
data = json.load(open("runs/verify-task/eval.json", encoding="utf-8"))
assert data["status"] == "fail"
assert data["required"] == ["unit"]
assert data["dimensions"]["unit"]["status"] == "fail"
assert data["dimensions"]["unit"]["reason"].startswith("skip-only verification command")
assert data["dimensions"]["unit"]["latest_attempt"] == "003"
meta = json.load(open("runs/verify-task/artifacts/unit/verify.json", encoding="utf-8"))
assert meta["status"] == "fail"
assert meta["exit_code"] == 1
assert meta["command_exit_code"] == 0
assert meta["attempt"] == "003"
assert meta["guard"].startswith("skip-only verification command")
PY
pass "skip-only command fails verification despite exiting zero"

cat > legacy-skip-only-verifier.sh <<'SH'
#!/usr/bin/env sh
cat > runs/verify-task/eval.json <<'JSON'
{
  "task_id": "verify-task",
  "status": "pass",
  "checks": [
    {"name": "unit_tests", "status": "skipped", "artifact": ""},
    {"name": "ui", "status": "skipped", "artifact": ""}
  ],
  "artifacts": ["runs/verify-task/artifacts"],
  "notes": [],
  "score": null
}
JSON
exit 0
SH
chmod +x legacy-skip-only-verifier.sh

if ./v2/kit/scripts/verify.sh verify-task unit -- ./legacy-skip-only-verifier.sh > legacy-skip-only.out 2> legacy-skip-only.err; then
  fail "legacy skip-only verifier unexpectedly passed"
fi
assert_contains "legacy-skip-only.out" "runs/verify-task/artifacts/unit/verify.log"
assert_file "runs/verify-task/artifacts/unit/attempt-004.log"
assert_file "runs/verify-task/artifacts/unit/attempt-004.json"
assert_contains "runs/verify-task/artifacts/unit/attempt-004.log" "verify_guard: skip-only verification command: eval only reports skipped"
assert_contains "runs/verify-task/artifacts/unit/attempt-004.log" "command_exit_code: 0"
assert_contains "runs/verify-task/artifacts/unit/attempt-004.log" "exit_code: 1"
python3 - <<'PY'
import json
data = json.load(open("runs/verify-task/eval.json", encoding="utf-8"))
assert data["status"] == "fail"
assert data["required"] == ["unit"]
assert data["dimensions"]["unit"]["status"] == "fail"
assert data["dimensions"]["unit"]["reason"].startswith("skip-only verification command")
assert data["dimensions"]["unit"]["latest_attempt"] == "004"
assert "checks" not in data
meta = json.load(open("runs/verify-task/artifacts/unit/verify.json", encoding="utf-8"))
assert meta["status"] == "fail"
assert meta["exit_code"] == 1
assert meta["command_exit_code"] == 0
assert meta["attempt"] == "004"
assert "eval only reports skipped" in meta["guard"]
PY
pass "legacy skip-only eval data fails verification despite exiting zero"

cat > legacy-verifier.sh <<'SH'
#!/usr/bin/env sh
cat > runs/verify-task/eval.json <<'JSON'
{
  "task_id": "verify-task",
  "status": "pass",
  "checks": [
    {"name": "unit_tests", "status": "passed", "artifact": "unit.log"},
    {"name": "ui", "status": "skipped", "artifact": ""}
  ],
  "artifacts": ["runs/verify-task/artifacts"],
  "notes": [],
  "score": null
}
JSON
exit 0
SH
chmod +x legacy-verifier.sh

./v2/kit/scripts/verify.sh verify-task unit -- ./legacy-verifier.sh > legacy.out
assert_contains "legacy.out" "runs/verify-task/artifacts/unit/verify.log"
assert_file "runs/verify-task/artifacts/unit/eval-before-attempt-005.json"
python3 - <<'PY'
import json
data = json.load(open("runs/verify-task/eval.json", encoding="utf-8"))
assert data["status"] == "pass"
assert data["required"] == ["unit"]
assert data["dimensions"]["unit"]["status"] == "pass"
assert data["dimensions"]["unit"]["latest_attempt"] == "005"
assert "checks" not in data
PY
pass "verify restores canonical eval schema after mixed legacy verifier writes eval.json"

if ./v2/kit/scripts/verify.sh verify-task unit -- sh -c 'echo failing command; exit 7' > fail.out 2> fail.err; then
  fail "failing command unexpectedly passed"
fi
assert_contains "fail.out" "runs/verify-task/artifacts/unit/verify.log"
assert_file "runs/verify-task/artifacts/unit/attempt-006.log"
assert_file "runs/verify-task/artifacts/unit/attempt-006.json"
assert_contains "runs/verify-task/artifacts/unit/attempt-001.log" "passing command"
assert_contains "runs/verify-task/artifacts/unit/attempt-001.log" "exit_code: 0"
assert_contains "runs/verify-task/artifacts/unit/verify.log" "failing command"
assert_contains "runs/verify-task/artifacts/unit/verify.log" "attempt: 006"
assert_contains "runs/verify-task/artifacts/unit/verify.log" "exit_code: 7"
python3 - <<'PY'
import json
data = json.load(open("runs/verify-task/eval.json", encoding="utf-8"))
assert data["status"] == "fail"
assert data["required"] == ["unit"]
assert data["dimensions"]["unit"]["status"] == "fail"
assert data["dimensions"]["unit"]["reason"] == "command exited 7"
assert data["dimensions"]["unit"]["latest_attempt"] == "006"
assert data["dimensions"]["unit"]["latest_attempt_artifact"] == "runs/verify-task/artifacts/unit/attempt-006.log"
meta = json.load(open("runs/verify-task/artifacts/unit/verify.json", encoding="utf-8"))
assert meta["status"] == "fail"
assert meta["exit_code"] == 7
assert meta["command_exit_code"] == 7
assert meta["attempt"] == "006"
PY
pass "failing command preserves attempts and fails dimension"

echo "verify-wrapper: all checks passed"
