#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: task.sh <id> [--mode emergent|planned|investigation|maintenance] [--description text] [--estimate-loc n] [--research-required] [--emit-env]
USAGE
  exit 2
}

[[ $# -ge 1 ]] || usage

TASK_ID="$1"
shift
MODE="emergent"
EMIT_ENV=0
DESCRIPTION=""
ESTIMATE_LOC=""
RESEARCH_REQUIRED=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      [[ $# -ge 2 ]] || usage
      MODE="$2"
      shift 2
      ;;
    --emit-env)
      EMIT_ENV=1
      shift
      ;;
    --description)
      [[ $# -ge 2 ]] || usage
      DESCRIPTION="$2"
      shift 2
      ;;
    --estimate-loc)
      [[ $# -ge 2 ]] || usage
      ESTIMATE_LOC="$2"
      shift 2
      ;;
    --research-required)
      RESEARCH_REQUIRED=1
      shift
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage
      ;;
  esac
done

if [[ ! "${TASK_ID}" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "error: task id must be kebab-case matching ^[a-z][a-z0-9-]*$: ${TASK_ID}" >&2
  exit 2
fi

case "${MODE}" in
  emergent|planned|investigation|maintenance) ;;
  *)
    echo "error: invalid mode: ${MODE}" >&2
    exit 2
    ;;
esac

RUN_DIR="runs/${TASK_ID}"
if [[ -e "${RUN_DIR}" ]]; then
  echo "error: run already exists: ${RUN_DIR}" >&2
  exit 1
fi

CREATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
PRETASK_STAGING=".harness/pre-task-artifacts/${TASK_ID}"

rm -rf "${PRETASK_STAGING}"
if [[ -x "v2/kit/scripts/pre-task.sh" ]]; then
  "v2/kit/scripts/pre-task.sh" "${TASK_ID}" --artifact-dir "${PRETASK_STAGING}" >&2
fi

mkdir -p "${RUN_DIR}/memory" "${RUN_DIR}/artifacts" ".harness"
if [[ -d "${PRETASK_STAGING}" ]]; then
  mkdir -p "${RUN_DIR}/artifacts"
  mv "${PRETASK_STAGING}" "${RUN_DIR}/artifacts/pre-task"
fi

if [[ -x "v2/kit/scripts/debt-snapshot.sh" ]]; then
  if ! "v2/kit/scripts/debt-snapshot.sh" "${TASK_ID}" >&2; then
    echo "warning: debt baseline capture failed for ${TASK_ID}" >&2
  fi
fi

python3 - "${TASK_ID}" "${MODE}" "${CREATED_AT}" "${RUN_DIR}" "${DESCRIPTION}" "${ESTIMATE_LOC}" "${RESEARCH_REQUIRED}" <<'PY'
import json
import pathlib
import sys

task_id, mode, created_at, run_dir, description, estimate_loc, research_required_arg = sys.argv[1:8]
run = pathlib.Path(run_dir)
config_path = pathlib.Path(".harness/config.json")
config = {}
if config_path.exists():
    config = json.loads(config_path.read_text(encoding="utf-8"))

research_threshold = int(config.get("research_loc_threshold", 500))
estimated = None
if estimate_loc:
    try:
        estimated = int(estimate_loc)
    except ValueError:
        raise SystemExit(f"error: --estimate-loc must be an integer: {estimate_loc}")
    if estimated < 0:
        raise SystemExit("error: --estimate-loc must be non-negative")

research_required = research_required_arg == "1"
research_reasons = []
if research_required:
    research_reasons.append("explicit")
if estimated is not None and estimated >= research_threshold:
    research_required = True
    research_reasons.append(f"estimate-loc>={research_threshold}")

meta = {
    "id": task_id,
    "mode": mode,
    "created_at": created_at,
    "status": "active",
}
if description:
    meta["description"] = description
if estimated is not None:
    meta["estimated_loc"] = estimated
if research_required:
    meta["research_required"] = True
    meta["research_reason"] = ", ".join(research_reasons)
    meta["research_path"] = f"runs/{task_id}/research.md"

(run / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

if mode == "investigation":
    eval_data = {
        "task_id": task_id,
        "status": "pass",
        "required": [],
        "dimensions": {},
    }
else:
    eval_data = {
        "task_id": task_id,
        "status": "pending",
        "required": ["unit"],
        "dimensions": {
            "unit": {"status": "pending"},
        },
    }

(run / "eval.json").write_text(json.dumps(eval_data, indent=2) + "\n", encoding="utf-8")

(run / "task-log.md").write_text(f"""# Task {task_id}

Created: {created_at}
Mode: {mode}
{f"Description: {description}" if description else ""}

## What I changed

## Why

## Notes
""", encoding="utf-8")

if mode == "investigation":
    (run / "notes.md").write_text(f"""# Investigation {task_id}

Created: {created_at}

## Question

## Findings

## Evidence

## Next steps
""", encoding="utf-8")

(run / "memory" / "001-initial.md").write_text(f"""---
seq: 001
date: {created_at}
trigger: task-start
topic: initial
---

## Decided

## Still open

## Where we are
""", encoding="utf-8")
PY

printf '%s\n' "${TASK_ID}" > ".harness/current-task"

if [[ -x "v2/kit/scripts/tasks-index.sh" ]]; then
  "v2/kit/scripts/tasks-index.sh" refresh "${TASK_ID}" >/dev/null
fi

if [[ -x "v2/kit/scripts/coordination.sh" ]]; then
  "v2/kit/scripts/coordination.sh" write "${TASK_ID}" --intent task-start >/dev/null
fi

if [[ "${EMIT_ENV}" -eq 1 ]]; then
  echo "Created ${RUN_DIR}" >&2
  printf 'export TASK_ID=%s\n' "${TASK_ID}"
else
  echo "${RUN_DIR}"
fi
