#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "${ROOT_DIR}/../.." && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH}"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

mkdir -p "${SCRATCH}/v2/kit" "${SCRATCH}/state/invariants"
ln -s "${ROOT_DIR}/scripts" "${SCRATCH}/v2/kit/scripts"
cat > "${SCRATCH}/state/invariants/10-current-task.sh" <<SH
#!/usr/bin/env bash
exec "${REPO_DIR}/state/invariants/10-current-task.sh" "\$@"
SH
chmod +x "${SCRATCH}/state/invariants/10-current-task.sh"
cd "${SCRATCH}"

cat > state/invariants/00-pass.sh <<'SH'
#!/usr/bin/env bash
echo pass invariant
SH
chmod +x state/invariants/00-pass.sh

./v2/kit/scripts/pre-task.sh ok-task > pass.out
grep -Fq "state invariant check passed" pass.out || fail "pre-task did not pass"
grep -Fq "pass invariant" runs/ok-task/artifacts/pre-task/00-pass.sh.log || fail "pass output not captured"
pass "pre-task passes with executable invariant"

ln -s 00-pass.sh state/invariants/02-linked-pass.sh
./v2/kit/scripts/pre-task.sh symlink-policy > symlink-policy.out
grep -Fq "state invariant check passed" symlink-policy.out || fail "pre-task did not pass with symlink present"
[[ ! -e runs/symlink-policy/artifacts/pre-task/02-linked-pass.sh.log ]] || fail "symlinked invariant was executed"
pass "pre-task ignores symlinked invariants"

mkdir -p .harness custom-pre custom-post
cat > .harness/config.json <<'JSON'
{
  "pre_state_invariant_dirs": ["custom-pre"],
  "post_state_invariant_dirs": ["custom-post"]
}
JSON
cat > custom-pre/00-pre.sh <<'SH'
#!/usr/bin/env bash
echo "pre stage: ${HARNESS_STAGE}"
echo "pre task: ${HARNESS_TASK_ID}"
echo "pre artifact: ${HARNESS_ARTIFACT_DIR}"
SH
chmod +x custom-pre/00-pre.sh
cat > custom-post/00-post.sh <<'SH'
#!/usr/bin/env bash
echo "post stage: ${HARNESS_STAGE}"
echo "post task: ${HARNESS_TASK_ID}"
echo "post artifact: ${HARNESS_ARTIFACT_DIR}"
SH
chmod +x custom-post/00-post.sh

./v2/kit/scripts/pre-task.sh staged-pre --artifact-dir staged-pre-artifacts > staged-pre.out
grep -Fq "pre-task state invariant check passed" staged-pre.out || fail "stage pre check did not pass"
grep -Fq "pre stage: pre" staged-pre-artifacts/00-pre.sh.log || fail "pre stage env not captured"
grep -Fq "pre task: staged-pre" staged-pre-artifacts/00-pre.sh.log || fail "pre task env not captured"
./v2/kit/scripts/post-task.sh staged-post --artifact-dir staged-post-artifacts > staged-post.out
grep -Fq "post-task state invariant check passed" staged-post.out || fail "stage post check did not pass"
grep -Fq "post stage: post" staged-post-artifacts/00-post.sh.log || fail "post stage env not captured"
grep -Fq '"stage": "post"' staged-post-artifacts/state-invariants.jsonl || fail "post jsonl did not record stage"
pass "state-check supports stage-specific dirs and context env"
rm -f .harness/config.json

mkdir -p .harness
printf 'missing-task\n' > .harness/current-task
if ./v2/kit/scripts/pre-task.sh bad-current --artifact-dir current-bad > current-bad.out 2> current-bad.err; then
  fail "pre-task unexpectedly passed missing current task"
fi
grep -Fq "missing run dir" current-bad/10-current-task.sh.log || fail "missing current task not reported"
rm -f .harness/current-task
pass "current-task invariant fails missing run"

./v2/kit/scripts/task.sh current-task > /dev/null
./v2/kit/scripts/eval-dim.sh set current-task unit pass --artifact runs/current-task/artifacts/unit.log > /dev/null
python3 - <<'PY'
from pathlib import Path

Path("runs/current-task/task-log.md").write_text("""# Task current-task

## What I changed

- Completed the current-task invariant fixture.

## Why

- State invariant tests need a done task.

## Notes
""", encoding="utf-8")
PY
./v2/kit/scripts/done.sh current-task > /dev/null
printf 'current-task\n' > .harness/current-task
if ./v2/kit/scripts/pre-task.sh done-current --artifact-dir current-done > current-done.out 2> current-done.err; then
  fail "pre-task unexpectedly passed done current task"
fi
grep -Fq "expected active status, got done" current-done/10-current-task.sh.log || fail "done current task not reported"
rm -f .harness/current-task
pass "current-task invariant fails completed run"

cat > state/invariants/01-fail.sh <<'SH'
#!/usr/bin/env bash
echo failing invariant
exit 7
SH
chmod +x state/invariants/01-fail.sh

if ./v2/kit/scripts/task.sh blocked-task > blocked.out 2> blocked.err; then
  fail "task unexpectedly succeeded despite failing invariant"
fi

[[ ! -d runs/blocked-task ]] || fail "task dir was created after invariant failure"
grep -Fq "state invariant check failed" blocked.err || fail "failure message missing"
grep -Fq "failing invariant" .harness/pre-task-artifacts/blocked-task/01-fail.sh.log || fail "failing output not captured"
pass "task fails before run creation when invariant fails"

echo "state-invariants: all checks passed"
