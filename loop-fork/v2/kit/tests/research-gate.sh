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
ln -s "${REPO_DIR}/.harness/hooks/research-gate.sh" "${SCRATCH}/.harness/hooks/research-gate.sh"
cd "${SCRATCH}"

cat > .harness/config.json <<'JSON'
{
  "research_loc_threshold": 200
}
JSON

./harness task big-feature --mode planned --estimate-loc 250 > /dev/null
./harness plan --init > /dev/null
assert_contains "runs/big-feature/meta.json" "\"research_required\": true"
assert_contains "runs/big-feature/plan.md" "Required Reuse Research"

if ./harness preflight big-feature > preflight-missing.out 2> preflight-missing.err; then
  fail "preflight unexpectedly passed without required research"
fi
assert_contains "preflight-missing.err" "research required but missing"
pass "research-required tasks fail preflight without research artifact"

./harness research --init big-feature > init.out
assert_contains "init.out" "runs/big-feature/research.md"
if ./harness research --gate big-feature > gate-template.out 2> gate-template.err; then
  fail "research gate unexpectedly passed template placeholders"
fi
assert_contains "gate-template.err" "Candidates Reviewed"
pass "research gate rejects placeholder template"

cat > complete-research.md <<'MD'
# big-feature Research

## Research Question

What reusable options exist?

## Candidates Reviewed

- Library A: https://example.com/library-a fits the API shape but not the shell-only constraint.
- Project B: https://example.com/project-b shows the implementation pattern to adapt.

## Open-Source Patterns

- Established implementations keep candidate comparison and source links in a durable artifact.

## Reuse Decision

Build the shell integration locally, but reuse the documented artifact-gate pattern.

## Sources

- https://example.com/library-a
- https://example.com/project-b
MD

./harness research --save --file complete-research.md big-feature > save.out
assert_contains "save.out" "runs/big-feature/research.md"
./harness research --gate big-feature > gate-pass.out
assert_contains "gate-pass.out" "research gate passed: big-feature"
./.harness/hooks/research-gate.sh big-feature > hook-pass.out
assert_contains "hook-pass.out" "research gate passed: big-feature"
./harness preflight big-feature > preflight-pass.out
assert_contains "preflight-pass.out" "preflight passed: big-feature"
pass "completed research satisfies gate, hook, and preflight"

echo "research-gate: all checks passed"
