#!/usr/bin/env bash
# Regression eval: scripts/check-baseline-allowlist.py must FAIL CLOSED.
#
# Origin (review DISSENT at cca7bef): the gate exited 0 printing "baseline
# allowlist empty" for runs/worker-pane/eval.json even though that eval records
# full_suite status "baseline_failures_only" with four known failures and
# verdict "pass_with_known_limitations" — legacy tolerated-baseline vocabulary
# the gate did not recognize. Empty/missing allowlist while the eval records
# known failures must be a nonzero exit.
#
# Run from the repo root: bash evals/regression/baseline-allowlist-fail-closed.sh
# Exits 0 iff every case behaves.
set -euo pipefail

cd "$(dirname "$0")/../.."
GATE="scripts/check-baseline-allowlist.py"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

failures=0

expect() {
  # expect <name> <want: zero|nonzero> <eval-path...>
  local name="$1" want="$2"
  shift 2
  local got=0
  python3 "${GATE}" "$@" >"${TMP}/out" 2>"${TMP}/err" || got=$?
  case "${want}" in
    zero)
      if [ "${got}" -ne 0 ]; then
        echo "FAIL ${name}: expected exit 0, got ${got}"
        sed 's/^/    /' "${TMP}/err"
        failures=$((failures + 1))
        return
      fi
      ;;
    nonzero)
      if [ "${got}" -eq 0 ]; then
        echo "FAIL ${name}: expected nonzero exit, got 0 (fail-open)"
        sed 's/^/    /' "${TMP}/out"
        failures=$((failures + 1))
        return
      fi
      ;;
    *)
      echo "FAIL ${name}: bad expectation ${want}"
      failures=$((failures + 1))
      return
      ;;
  esac
  echo "ok   ${name} (exit ${got})"
}

# 1. Reviewer repro, verbatim: the real committed worker-pane eval records
#    known failures in legacy vocabulary and must fail the gate.
expect "repro-worker-pane-eval" nonzero runs/worker-pane/eval.json

# 2. Missing eval: absence of evidence is a failure, not a pass.
expect "missing-eval-file" nonzero "${TMP}/does-not-exist/eval.json"

# 3. Invalid JSON is a failure, not a crash-dependent accident.
echo '{not json' > "${TMP}/bad.json"
expect "invalid-json" nonzero "${TMP}/bad.json"

# 4. Clean eval: empty allowlist, no tolerated vocabulary — the only pass.
cat > "${TMP}/clean.json" <<'JSON'
{"task_id": "t", "verdict": "pass", "baseline_failures": [],
 "checks": [{"name": "full_suite", "status": "pass"}]}
JSON
expect "empty-allowlist-clean-vocabulary" zero "${TMP}/clean.json"

# 5. Named allowlist entries block release.
cat > "${TMP}/named.json" <<'JSON'
{"verdict": "pass", "baseline_failures": ["runner.test.ts > default model"]}
JSON
expect "named-allowlist-entry" nonzero "${TMP}/named.json"

# 6. Boolean flag instead of a list.
echo '{"verdict": "pass", "baseline_failures": true}' > "${TMP}/bool.json"
expect "allowlist-bool-flag" nonzero "${TMP}/bool.json"

# 7. Count instead of a list.
echo '{"verdict": "pass", "baseline_failures": 4}' > "${TMP}/count.json"
expect "allowlist-count" nonzero "${TMP}/count.json"

# 8. Retired result string.
echo '{"result": "pass_with_baseline_failures"}' > "${TMP}/retired.json"
expect "retired-result" nonzero "${TMP}/retired.json"

# 9. Legacy alias: a check status of baseline_failures_only, allowlist absent.
cat > "${TMP}/alias-status.json" <<'JSON'
{"verdict": "pass",
 "checks": [{"name": "full_suite", "status": "baseline_failures_only",
             "evidence": "787 passed; 4 known failures"}]}
JSON
expect "legacy-alias-status" nonzero "${TMP}/alias-status.json"

# 10. Legacy alias: verdict pass_with_known_limitations, allowlist empty.
cat > "${TMP}/alias-verdict.json" <<'JSON'
{"verdict": "pass_with_known_limitations", "baseline_failures": []}
JSON
expect "legacy-alias-verdict" nonzero "${TMP}/alias-verdict.json"

# 11. No argument is a usage error, never a pass.
expect "usage-no-args" nonzero

if [ "${failures}" -ne 0 ]; then
  echo "baseline-allowlist-fail-closed: ${failures} case(s) failed"
  exit 1
fi
echo "baseline-allowlist-fail-closed: all cases passed"
