#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: state-check.sh <task-id> <pre|post> [--config .harness/config.json] [--artifact-dir <dir>]
USAGE
  exit 2
}

[[ $# -ge 2 ]] || usage

TASK_ID="$1"
STAGE="$2"
shift 2
CONFIG=".harness/config.json"
ARTIFACT_DIR=""

case "${TASK_ID}" in
  *[!a-z0-9-]*|""|-*) echo "error: task id must be kebab-case" >&2; exit 2 ;;
esac

case "${STAGE}" in
  pre|post) ;;
  *) echo "error: stage must be pre or post" >&2; exit 2 ;;
esac

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      [[ $# -ge 2 ]] || usage
      CONFIG="$2"
      shift 2
      ;;
    --artifact-dir)
      [[ $# -ge 2 ]] || usage
      ARTIFACT_DIR="$2"
      shift 2
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage
      ;;
  esac
done

if [[ -z "${ARTIFACT_DIR}" ]]; then
  ARTIFACT_DIR="runs/${TASK_ID}/artifacts/${STAGE}-task"
fi

mkdir -p "${ARTIFACT_DIR}"
LOG="${ARTIFACT_DIR}/state-invariants.log"
JSONL="${ARTIFACT_DIR}/state-invariants.jsonl"
: > "${LOG}"
: > "${JSONL}"

python3 - "${CONFIG}" "${STAGE}" <<'PY' > "${ARTIFACT_DIR}/dirs.txt"
import json
import pathlib
import sys

config = pathlib.Path(sys.argv[1])
stage = sys.argv[2]
fallback = ["state/invariants"]

if not config.exists():
    print("\n".join(fallback))
    raise SystemExit(0)

data = json.loads(config.read_text(encoding="utf-8"))
stage_key = f"{stage}_state_invariant_dirs"
dirs = data.get(stage_key)
if dirs is None:
    dirs = data.get("state_invariant_dirs") or fallback
for item in dirs:
    print(item)
PY

status="pass"
found=0

while IFS= read -r dir; do
  [[ -n "${dir}" ]] || continue
  [[ -d "${dir}" ]] || continue
  # Invariants are intentionally regular executable files only. Symlinked
  # scripts are ignored so the runnable policy stays explicit in the repo.
  while IFS= read -r script; do
    found=1
    name="${script}"
    out="${ARTIFACT_DIR}/$(basename "${script}").log"
    {
      echo "[run] ${script}"
      if HARNESS_TASK_ID="${TASK_ID}" HARNESS_STAGE="${STAGE}" HARNESS_ARTIFACT_DIR="${ARTIFACT_DIR}" "${script}"; then
        echo "[pass] ${script}"
        result="pass"
      else
        code="$?"
        echo "[fail] ${script} exited ${code}"
        result="fail"
        status="fail"
      fi
      python3 - "${JSONL}" "${name}" "${result}" "${out}" "${STAGE}" <<'PY'
import json
import pathlib
import sys

path, name, status, artifact, stage = sys.argv[1:6]
with pathlib.Path(path).open("a", encoding="utf-8") as f:
    f.write(json.dumps({
        "name": name,
        "stage": stage,
        "status": status,
        "artifact": artifact,
    }) + "\n")
PY
    } > "${out}" 2>&1
    cat "${out}" >> "${LOG}"
  done < <(find "${dir}" -maxdepth 1 -type f -perm -111 | sort)
done < "${ARTIFACT_DIR}/dirs.txt"

if [[ "${found}" -eq 0 ]]; then
  echo "[skip] no executable state invariants found" | tee -a "${LOG}" >/dev/null
fi

rm -f "${ARTIFACT_DIR}/dirs.txt"

if [[ "${status}" != "pass" ]]; then
  echo "${STAGE}-task state invariant check failed; see ${LOG}" >&2
  exit 1
fi

echo "${STAGE}-task state invariant check passed; see ${LOG}"
