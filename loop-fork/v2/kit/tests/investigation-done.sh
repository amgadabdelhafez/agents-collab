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

mkdir -p "${SCRATCH}/v2/kit"
ln -s "${ROOT_DIR}/scripts" "${SCRATCH}/v2/kit/scripts"
cd "${SCRATCH}"

./v2/kit/scripts/task.sh research-done --mode investigation > /dev/null

if ./v2/kit/scripts/done.sh research-done > empty-notes.out 2> empty-notes.err; then
  fail "done unexpectedly passed empty investigation notes"
fi
assert_contains "empty-notes.err" "investigation notes Findings is empty"
pass "investigation done blocks empty findings"

python3 - <<'PY'
from pathlib import Path

Path("runs/research-done/notes.md").write_text("""# Investigation research-done

## Question

Why does the harness need investigation mode?

## Findings

- Investigation tasks can complete from notes without unit evidence.

## Evidence

- Stop gate has no required dimensions for investigation mode.

## Next steps

- Use implementation tasks for code changes.
""", encoding="utf-8")

memory = Path("runs/research-done/memory/001-initial.md")
memory.write_text(memory.read_text(encoding="utf-8").replace(
    "## Decided\n\n## Still open",
    "## Decided\n\n- Notes are the primary investigation artifact.\n\n## Still open"
), encoding="utf-8")
PY

./v2/kit/scripts/done.sh research-done > done.out
assert_contains "done.out" "specs/research-done.md"
assert_contains "specs/research-done.md" "Investigation tasks can complete from notes"
assert_contains "runs/research-done/meta.json" "\"status\": \"done\""
[[ ! -e ".harness/current-task" ]] || fail ".harness/current-task was not removed"
pass "investigation done uses notes findings"

echo "investigation-done: all checks passed"
