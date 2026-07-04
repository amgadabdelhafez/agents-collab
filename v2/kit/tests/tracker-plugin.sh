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

./harness tracker status > status-none.json
assert_contains "status-none.json" "\"provider\": \"none\""
./harness tracker create --title "No tracker issue" > create-none.json
assert_contains "create-none.json" "\"status\": \"skipped\""
[[ ! -f ".harness/tracker-issues.jsonl" ]] || fail "disabled tracker wrote issues"
pass "tracker none provider is a no-op"

mkdir -p .harness
cat > .harness/tracker.json <<'JSON'
{
  "provider": "file",
  "id_prefix": "LOCAL",
  "url_prefix": "https://gitea.example.test/repo/issues",
  "issues_path": ".harness/issues.jsonl",
  "comments_path": ".harness/comments.jsonl",
  "links_path": ".harness/links.jsonl"
}
JSON

./harness tracker create --title "Security finding" --body "Check permissions" --artifact runs/task/artifacts/security.md --task audit-task --label security > create-file.json
assert_contains "create-file.json" "\"status\": \"created\""
assert_contains "create-file.json" "\"id\": \"LOCAL-1\""
assert_contains ".harness/issues.jsonl" "\"title\": \"Security finding\""
assert_contains ".harness/links.jsonl" "https://gitea.example.test/repo/issues/LOCAL-1"

./harness tracker comment LOCAL-1 --body "Added reproduction notes" --task audit-task > comment.json
assert_contains "comment.json" "\"status\": \"commented\""
assert_contains ".harness/comments.jsonl" "Added reproduction notes"

./harness tracker link --artifact runs/task/artifacts/live.log --url https://gitea.example.test/repo/issues/99 --issue GITEA-99 --task audit-task > link.json
assert_contains "link.json" "\"status\": \"linked\""
assert_contains ".harness/links.jsonl" "GITEA-99"
pass "file tracker provider creates comments and artifact links"

echo "tracker-plugin: all checks passed"
