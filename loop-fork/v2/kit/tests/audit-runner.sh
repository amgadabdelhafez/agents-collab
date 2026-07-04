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

mkdir -p "${SCRATCH}/v2/kit" "${SCRATCH}/.harness" "${SCRATCH}/fixture"
ln -s "${REPO_DIR}/v2/kit/scripts" "${SCRATCH}/v2/kit/scripts"
ln -s "${REPO_DIR}/harness" "${SCRATCH}/harness"
cd "${SCRATCH}"

cat > .harness/tracker.json <<'JSON'
{
  "provider": "file",
  "id_prefix": "AUDIT",
  "url_prefix": "https://gitea.example.test/repo/issues",
  "issues_path": ".harness/issues.jsonl",
  "links_path": ".harness/links.jsonl"
}
JSON

cat > fixture/app.py <<'PY'
password = "supersecret"
print("hello")
PY

cat > fixture/install.sh <<'SH'
curl https://example.test/install.sh | sh
SH

cat > fixture/index.html <<'HTML'
<img src="hero.png">
<button></button>
HTML

cat > .harness/config.json <<'JSON'
{
  "audit_large_file_loc_threshold": 2
}
JSON

./harness task audit-task > /dev/null
./harness audit security --path fixture > security.out
assert_contains "security.out" "runs/audit-task/artifacts/audits/security.md"
assert_contains "runs/audit-task/artifacts/audits/security.md" "Secret-like value in source"
assert_contains "runs/audit-task/artifacts/audits/security.md" "Remote script piped to shell"
assert_contains "debt/register.jsonl" "\"signal\": \"audit_security\""
assert_contains ".harness/issues.jsonl" "security: Secret-like value in source"
assert_contains ".harness/links.jsonl" "runs/audit-task/artifacts/audits/security.md"
pass "security audit writes report debt rows and tracker issues"

./harness audit accessibility --path fixture > accessibility.out
assert_contains "runs/audit-task/artifacts/audits/accessibility.md" "Image missing alt text"
assert_contains "runs/audit-task/artifacts/audits/accessibility.md" "Button has no accessible label"
pass "accessibility audit writes deterministic findings"

./harness audit performance --path fixture > performance.out
assert_contains "runs/audit-task/artifacts/audits/performance.md" "Large file crosses LOC threshold"
pass "performance audit writes deterministic findings"

echo "audit-runner: all checks passed"
