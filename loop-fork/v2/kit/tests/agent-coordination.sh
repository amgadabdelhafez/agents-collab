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

HARNESS_AGENT_ID=codex-one ./harness task coord-task > /dev/null
assert_contains "agents/coordination.jsonl" "\"intent\": \"task-start\""
assert_contains "agents/coordination.jsonl" "\"agent\": \"codex-one\""
pass "task start appends coordination row"

HARNESS_AGENT_ID=codex-one ./harness coordinate editing --file src/tts-common.sh > coordinate.out
assert_contains "coordinate.out" "\"intent\": \"editing\""
assert_contains "coordinate.out" "\"file\": \"src/tts-common.sh\""

./harness coordination --tail 2 > tail.out
assert_contains "tail.out" "intent=task-start"
assert_contains "tail.out" "intent=editing file=src/tts-common.sh"

./harness coordination --tail 1 --json --file src/tts-common.sh > tail.json
python3 - <<'PY'
import json
data = json.load(open("tail.json", encoding="utf-8"))
rows = data["coordination"]
assert len(rows) == 1
assert rows[0]["intent"] == "editing"
assert rows[0]["file"] == "src/tts-common.sh"
PY
pass "coordination command shows recent file-specific intent"

./harness eval set coord-task unit pass --artifact artifacts/unit.log > /dev/null
python3 - <<'PY'
from pathlib import Path

Path("runs/coord-task/task-log.md").write_text("""# Task coord-task

## What I changed

- Exercised coordination lifecycle rows.

## Why

- Agents need shared repo-local intent before overlapping edits.

## Notes
""", encoding="utf-8")
PY
HARNESS_AGENT_ID=codex-one ./harness done > done.out 2> done.err
assert_contains "done.out" "specs/coord-task.md"
assert_contains "agents/coordination.jsonl" "\"intent\": \"done\""
pass "done appends coordination row"

echo "agent-coordination: all checks passed"
