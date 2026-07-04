#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRATCH="$(mktemp -d)"
SOURCE_DIR="$(mktemp -d)"
trap 'rm -rf "${SCRATCH}" "${SOURCE_DIR}"' EXIT

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

mkdir -p sessions
cat > "${SOURCE_DIR}/matching.jsonl" <<JSONL
{"cwd":"${SCRATCH}","created_at":"2026-04-20T10:00:00Z","type":"user","message":{"role":"user","content":[{"type":"text","text":"Human exported message about durable session analysis."}]}}
{"cwd":"${SCRATCH}","created_at":"2026-04-20T10:01:00Z","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Assistant exported reply about using repo-local JSONL."}]}}
JSONL
cat > "${SOURCE_DIR}/other.jsonl" <<'JSONL'
{"cwd":"/tmp/not-this-repo","role":"user","content":"SHOULD_NOT_EXPORT"}
JSONL

./harness session-export --source "${SOURCE_DIR}" --file sessions/export.jsonl > export.out
assert_contains "export.out" "sessions/export.jsonl"
assert_file "sessions/export.jsonl"

python3 - <<'PY'
import json
from pathlib import Path

rows = [
    json.loads(line)
    for line in Path("sessions/export.jsonl").read_text(encoding="utf-8").splitlines()
    if line.strip()
]
assert len(rows) == 2
roles = {row["role"] for row in rows}
assert roles == {"user", "assistant"}
text = "\n".join(row["content"] for row in rows)
assert "Human exported message" in text
assert "Assistant exported reply" in text
assert "SHOULD_NOT_EXPORT" not in text
PY
pass "session-export writes filtered repo-local JSONL"

./harness retrospect --semantic --out reports/retrospect/exported > retrospect.out
assert_file "reports/retrospect/exported/inputs/content/human-messages.jsonl"
assert_file "reports/retrospect/exported/inputs/content/assistant-messages.jsonl"
python3 - <<'PY'
import json
from pathlib import Path

base = Path("reports/retrospect/exported")
metrics = json.loads((base / "metrics.json").read_text(encoding="utf-8"))
assert metrics["sessions"]["files"] == 1
assert metrics["sessions"]["records"] == 2
assert metrics["content"]["human_messages"] == 1
assert metrics["content"]["assistant_messages"] == 1
prompt = (base / "inputs/content/llm-prompt.md").read_text(encoding="utf-8")
assert "Human exported message about durable session analysis" in prompt
assert "Assistant exported reply about using repo-local JSONL" in prompt
assert "SHOULD_NOT_EXPORT" not in prompt
PY
pass "retrospect consumes exported session JSONL"

echo "session-export: all checks passed"
