#!/usr/bin/env bash
# Regression eval: scripts/verify.sh must not run against a defaulted task id.
#
# Origin (review DISSENT at cca7bef): root AGENTS.md and several specs invoke
# `scripts/verify.sh` with no task id; the script silently set
# ARTIFACTS_DIR=runs/unknown and skipped the baseline gate when that eval was
# absent, so the advertised release gate never ran. Without a task id verify.sh
# must be an explicit nonzero error, and with one the baseline gate must run.
#
# Run from the repo root: bash evals/regression/verify-requires-task-id.sh
# Exits 0 iff every case behaves.
set -euo pipefail

cd "$(dirname "$0")/../.."
TMP="$(mktemp -d)"
TASK_ID="tmp-verify-eval-$$"
trap 'rm -rf "${TMP}" "runs/${TASK_ID}"' EXIT

failures=0

# 1. Reviewer repro, verbatim: no arguments must be an explicit error.
got=0
bash scripts/verify.sh >"${TMP}/out1" 2>"${TMP}/err1" || got=$?
if [ "${got}" -eq 0 ]; then
  echo "FAIL no-args: verify.sh exited 0 without a task id (fail-open)"
  failures=$((failures + 1))
elif ! grep -q -- "--task-id is required" "${TMP}/err1"; then
  echo "FAIL no-args: exit ${got} but the error does not name --task-id"
  sed 's/^/    /' "${TMP}/err1"
  failures=$((failures + 1))
else
  echo "ok   no-args rejected (exit ${got})"
fi

# 2. A feature alone is still not a task id.
got=0
bash scripts/verify.sh --feature some-feature >"${TMP}/out2" 2>"${TMP}/err2" || got=$?
if [ "${got}" -eq 0 ]; then
  echo "FAIL feature-only: verify.sh exited 0 without a task id"
  failures=$((failures + 1))
else
  echo "ok   feature-only rejected (exit ${got})"
fi

# 3. Unknown arguments are errors, not silently mis-bound positionals.
got=0
bash scripts/verify.sh some-feature "${TASK_ID}" >"${TMP}/out3" 2>"${TMP}/err3" || got=$?
if [ "${got}" -eq 0 ]; then
  echo "FAIL positional: legacy positional call was accepted"
  failures=$((failures + 1))
else
  echo "ok   legacy positional call rejected (exit ${got})"
fi

# 4. With a task id the run binds to runs/<task-id> and the gate RUNS.
got=0
bash scripts/verify.sh --task-id "${TASK_ID}" --feature gate-eval \
  >"${TMP}/out4" 2>"${TMP}/err4" || got=$?
if [ "${got}" -ne 0 ]; then
  echo "FAIL task-id: verify.sh exited ${got} for a fresh task id"
  sed 's/^/    /' "${TMP}/err4"
  failures=$((failures + 1))
else
  ok=1
  grep -q "task=${TASK_ID} feature=gate-eval" "${TMP}/out4" || {
    echo "FAIL task-id: banner does not bind task=${TASK_ID} feature=gate-eval"
    ok=0
  }
  grep -q -- "--- baseline allowlist ---" "${TMP}/out4" || {
    echo "FAIL task-id: baseline gate step did not run"
    ok=0
  }
  grep -q "baseline allowlist empty: runs/${TASK_ID}/eval.json" "${TMP}/out4" || {
    echo "FAIL task-id: gate did not check runs/${TASK_ID}/eval.json"
    ok=0
  }
  if [ "${ok}" -eq 1 ]; then
    echo "ok   task-id run bound to runs/${TASK_ID} and the gate ran"
  else
    sed 's/^/    /' "${TMP}/out4"
    failures=$((failures + 1))
  fi
fi

# 5. A tolerated-baseline eval fails the whole verify run (gate wired, not
#    cosmetic): reuse the committed worker-pane eval via a scratch task dir.
SCRATCH_TASK="tmp-verify-gate-$$"
mkdir -p "runs/${SCRATCH_TASK}"
cp runs/worker-pane/eval.json "runs/${SCRATCH_TASK}/eval.json"
got=0
bash scripts/verify.sh --task-id "${SCRATCH_TASK}" >"${TMP}/out5" 2>"${TMP}/err5" || got=$?
rm -rf "runs/${SCRATCH_TASK}"
if [ "${got}" -eq 0 ]; then
  echo "FAIL gate-wired: verify.sh passed a tolerated-baseline eval"
  failures=$((failures + 1))
else
  echo "ok   tolerated-baseline eval fails verify.sh (exit ${got})"
fi

if [ "${failures}" -ne 0 ]; then
  echo "verify-requires-task-id: ${failures} case(s) failed"
  exit 1
fi
echo "verify-requires-task-id: all cases passed"
