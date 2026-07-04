#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: verify.sh <task-id> <dimension> -- <command> [args...]
USAGE
  exit 2
}

[[ $# -ge 4 ]] || usage

TASK_ID="$1"
DIMENSION="$2"
shift 2

case "${TASK_ID}" in
  *[!a-z0-9-]*|""|-*) echo "error: task id must be kebab-case" >&2; exit 2 ;;
esac

case "${DIMENSION}" in
  *[!a-z0-9-]*|""|-*) echo "error: dimension must be kebab-case" >&2; exit 2 ;;
esac

[[ "${1:-}" == "--" ]] || usage
shift
[[ $# -ge 1 ]] || usage

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="runs/${TASK_ID}"
EVAL="${RUN_DIR}/eval.json"
ARTIFACT_DIR="${RUN_DIR}/artifacts/${DIMENSION}"
LOG="${ARTIFACT_DIR}/verify.log"
META="${ARTIFACT_DIR}/verify.json"
LOCK_ROOT=".harness/locks"
LOCK_DIR="${LOCK_ROOT}/verify-${TASK_ID}-${DIMENSION}.lock"

[[ -d "${RUN_DIR}" ]] || {
  echo "error: run does not exist: ${RUN_DIR}" >&2
  exit 1
}

[[ -f "${EVAL}" ]] || {
  echo "error: missing eval file: ${EVAL}" >&2
  exit 1
}

mkdir -p "${ARTIFACT_DIR}"
mkdir -p "${LOCK_ROOT}"
if mkdir "${LOCK_DIR}" 2>/dev/null; then
  {
    printf 'pid=%s\n' "$$"
    printf 'created_at=%s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    printf 'command=verify\n'
    printf 'task_id=%s\n' "${TASK_ID}"
    printf 'dimension=%s\n' "${DIMENSION}"
  } > "${LOCK_DIR}/owner"
else
  echo "error: lock exists: ${LOCK_DIR} (remove if stale)" >&2
  exit 1
fi

cleanup_lock() {
  rm -rf "${LOCK_DIR}"
}
trap cleanup_lock EXIT INT TERM

ATTEMPT="$(python3 - "${ARTIFACT_DIR}" <<'PY'
import pathlib
import re
import sys

artifact_dir = pathlib.Path(sys.argv[1])
attempts = []
for path in artifact_dir.glob("attempt-*.log"):
    match = re.match(r"^attempt-(\d{3})\.log$", path.name)
    if match:
        attempts.append(int(match.group(1)))
print(f"{max(attempts, default=0) + 1:03d}")
PY
)"
ATTEMPT_LOG="${ARTIFACT_DIR}/attempt-${ATTEMPT}.log"
ATTEMPT_META="${ARTIFACT_DIR}/attempt-${ATTEMPT}.json"
ATTEMPT_EVAL_BEFORE="${ARTIFACT_DIR}/eval-before-attempt-${ATTEMPT}.json"
STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

cp "${EVAL}" "${ATTEMPT_EVAL_BEFORE}"

set +e
{
  printf 'task_id: %s\n' "${TASK_ID}"
  printf 'dimension: %s\n' "${DIMENSION}"
  printf 'attempt: %s\n' "${ATTEMPT}"
  printf 'started_at: %s\n' "${STARTED_AT}"
  printf 'command:'
  printf ' %q' "$@"
  printf '\n--- output ---\n'
  "$@"
} > "${ATTEMPT_LOG}" 2>&1
STATUS=$?
set -e
COMMAND_STATUS="${STATUS}"

SKIP_ONLY_REASON=""
if [[ "${COMMAND_STATUS}" -eq 0 ]]; then
  SKIP_ONLY_REASON="$(python3 - "${ATTEMPT_LOG}" "${EVAL}" "${ATTEMPT_EVAL_BEFORE}" <<'PY'
import json
import pathlib
import re
import sys

log_path, eval_path, before_path = sys.argv[1:4]
target_checks = {"lint", "typecheck", "unit", "integration", "ui"}
skip_statuses = {"skip", "skipped"}

skip_re = re.compile(r"\b(skip|skipped)\b", re.IGNORECASE)
non_skip_re = re.compile(
    r"\b(pass|passed|passes|ok|success|succeeded|fail|failed|sign-off-granted)\b",
    re.IGNORECASE,
)


def tokens(text: object) -> list[str]:
    normalized = str(text or "").lower()
    normalized = re.sub(r"type[\s_-]*check", "typecheck", normalized)
    return re.findall(r"[a-z0-9]+", normalized)


def has_target(text: object) -> bool:
    return bool(target_checks.intersection(tokens(text)))


def output_lines() -> list[str]:
    try:
        lines = pathlib.Path(log_path).read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return []

    collected: list[str] = []
    in_output = False
    for line in lines:
        if line == "--- output ---":
            in_output = True
            continue
        if line == "--- result ---":
            break
        if in_output and line.strip():
            collected.append(line.strip())
    return collected


def skip_only_output() -> bool:
    statuses: list[str] = []
    for line in output_lines():
        if not has_target(line):
            continue
        if non_skip_re.search(line):
            statuses.append("not-skipped")
        elif skip_re.search(line):
            statuses.append("skipped")

    return bool(statuses) and all(status == "skipped" for status in statuses)


def load_json(path: str) -> dict:
    try:
        data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def eval_changed() -> bool:
    try:
        return pathlib.Path(eval_path).read_text(encoding="utf-8") != pathlib.Path(before_path).read_text(encoding="utf-8")
    except FileNotFoundError:
        return False


def status_name(value: object) -> str:
    return re.sub(r"[\s_-]+", "-", str(value or "").strip().lower())


def eval_statuses(data: dict) -> list[str]:
    statuses: list[str] = []

    checks = data.get("checks")
    if isinstance(checks, list):
        for check in checks:
            if not isinstance(check, dict):
                continue
            name = check.get("name") or check.get("id") or check.get("dimension") or ""
            if has_target(name):
                statuses.append(status_name(check.get("status")))

    dimensions = data.get("dimensions")
    if isinstance(dimensions, dict):
        for name, record in dimensions.items():
            if isinstance(record, dict) and has_target(name):
                statuses.append(status_name(record.get("status")))

    return statuses


def skip_only_eval() -> bool:
    if not eval_changed():
        return False
    statuses = eval_statuses(load_json(eval_path))
    return bool(statuses) and all(status in skip_statuses for status in statuses)


if skip_only_output():
    print("skip-only verification command: output only reports skipped lint/typecheck/unit/integration/ui checks")
elif skip_only_eval():
    print("skip-only verification command: eval only reports skipped lint/typecheck/unit/integration/ui checks")
PY
)"
fi

if [[ -n "${SKIP_ONLY_REASON}" ]]; then
  STATUS=1
fi

ENDED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
{
  printf '\n--- result ---\n'
  printf 'command_exit_code: %s\n' "${COMMAND_STATUS}"
  if [[ -n "${SKIP_ONLY_REASON}" ]]; then
    printf 'verify_guard: %s\n' "${SKIP_ONLY_REASON}"
  fi
  printf 'exit_code: %s\n' "${STATUS}"
  printf 'ended_at: %s\n' "${ENDED_AT}"
} >> "${ATTEMPT_LOG}"

python3 - "${ATTEMPT_META}" "${TASK_ID}" "${DIMENSION}" "${ATTEMPT}" "${STATUS}" "${COMMAND_STATUS}" "${SKIP_ONLY_REASON}" "${STARTED_AT}" "${ENDED_AT}" "${ATTEMPT_LOG}" "$@" <<'PY'
import json
import pathlib
import sys

meta_path, task_id, dimension, attempt, status, command_status, guard_reason, started_at, ended_at, log_path, *command = sys.argv[1:]
data = {
    "task_id": task_id,
    "dimension": dimension,
    "attempt": attempt,
    "status": "pass" if int(status) == 0 else "fail",
    "exit_code": int(status),
    "command_exit_code": int(command_status),
    "started_at": started_at,
    "ended_at": ended_at,
    "artifact": log_path,
    "command": command,
}
if guard_reason:
    data["guard"] = guard_reason
pathlib.Path(meta_path).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY

cp "${ATTEMPT_LOG}" "${LOG}"
cp "${ATTEMPT_META}" "${META}"

if [[ "${STATUS}" -eq 0 ]]; then
  DIMENSION_STATUS="pass"
  REASON="command exited 0"
elif [[ -n "${SKIP_ONLY_REASON}" ]]; then
  DIMENSION_STATUS="fail"
  REASON="${SKIP_ONLY_REASON}"
else
  DIMENSION_STATUS="fail"
  REASON="command exited ${STATUS}"
fi

python3 - "${EVAL}" "${ATTEMPT_EVAL_BEFORE}" "${TASK_ID}" "${DIMENSION}" <<'PY'
import json
import pathlib
import sys

eval_path, before_path, task_id, dimension = sys.argv[1:5]

def load_json(path: str) -> dict:
    try:
        data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}

before = load_json(before_path)
current = load_json(eval_path)

required = before.get("required")
if not isinstance(required, list) or not all(isinstance(item, str) for item in required):
    required = current.get("required")
if not isinstance(required, list) or not all(isinstance(item, str) for item in required):
    required = []

if dimension not in required:
    required.append(dimension)

dimensions = before.get("dimensions")
if not isinstance(dimensions, dict):
    dimensions = {}
else:
    dimensions = {key: value for key, value in dimensions.items() if isinstance(key, str) and isinstance(value, dict)}

current_dimensions = current.get("dimensions")
if isinstance(current_dimensions, dict):
    for key, value in current_dimensions.items():
        if isinstance(key, str) and isinstance(value, dict):
            dimensions[key] = value

for name in required:
    dimensions.setdefault(name, {"status": "pending"})

canonical = {
    "task_id": task_id,
    "status": "pending",
    "required": required,
    "dimensions": dimensions,
}

pathlib.Path(eval_path).write_text(json.dumps(canonical, indent=2) + "\n", encoding="utf-8")
PY

"${SCRIPT_DIR}/eval-dim.sh" set "${TASK_ID}" "${DIMENSION}" "${DIMENSION_STATUS}" \
  --artifact "${LOG}" \
  --method "verify.sh" \
  --reason "${REASON}" >/dev/null

python3 - "${EVAL}" "${DIMENSION}" "${ATTEMPT}" "${ATTEMPT_LOG}" "${ATTEMPT_META}" <<'PY'
import json
import pathlib
import sys

eval_path, dimension, attempt, attempt_log, attempt_meta = sys.argv[1:6]
path = pathlib.Path(eval_path)
data = json.loads(path.read_text(encoding="utf-8"))
record = data.setdefault("dimensions", {}).setdefault(dimension, {})
record["latest_attempt"] = attempt
record["latest_attempt_artifact"] = attempt_log
record["latest_attempt_meta"] = attempt_meta
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY

if [[ -x "${SCRIPT_DIR}/tasks-index.sh" ]]; then
  "${SCRIPT_DIR}/tasks-index.sh" refresh "${TASK_ID}" >/dev/null
fi

echo "${LOG}"
exit "${STATUS}"
