#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage:
  research.sh init <task-id> [--force]
  research.sh save <task-id> [--file <path>]
  research.sh status <task-id> [--json]
  research.sh gate <task-id> [--json]
USAGE
  exit 2
}

[[ $# -ge 2 ]] || usage

COMMAND="$1"
TASK_ID="$2"
shift 2
RUN_DIR="runs/${TASK_ID}"
META="${RUN_DIR}/meta.json"
RESEARCH="${RUN_DIR}/research.md"

case "${TASK_ID}" in
  *[!a-z0-9-]*|""|-*) echo "error: task id must be kebab-case" >&2; exit 2 ;;
esac

validate_research() {
  local json_output="$1"
  python3 - "${TASK_ID}" "${META}" "${RESEARCH}" "${json_output}" <<'PY'
import json
import pathlib
import re
import sys

task_id, meta_path, research_path, json_arg = sys.argv[1:5]
json_output = json_arg == "1"
meta = {}
meta_file = pathlib.Path(meta_path)
if meta_file.exists():
    meta = json.loads(meta_file.read_text(encoding="utf-8"))
required = bool(meta.get("research_required"))
path = pathlib.Path(research_path)

def emit(status: str, reason: str = "") -> None:
    payload = {
        "task_id": task_id,
        "status": status,
        "research_required": required,
        "research_path": str(path),
    }
    if reason:
        payload["reason"] = reason
    if json_output:
        print(json.dumps(payload, indent=2))
    elif status == "pass":
        print(f"research gate passed: {task_id}")
    elif status == "skipped":
        print(f"research gate skipped: {task_id}")
    else:
        print(f"error: {reason}", file=sys.stderr)

def section(text: str, heading: str) -> str:
    lines = text.splitlines()
    active = False
    collected = []
    for line in lines:
        if line.strip().lower() == heading.lower():
            active = True
            continue
        if active and line.startswith("## "):
            break
        if active:
            collected.append(line)
    return "\n".join(collected).strip()

if not required:
    emit("skipped")
    raise SystemExit(0)
if not path.exists():
    emit("fail", f"research required but missing: {path}")
    raise SystemExit(1)
text = path.read_text(encoding="utf-8")
if not text.strip():
    emit("fail", f"research file is empty: {path}")
    raise SystemExit(1)

candidates = section(text, "## Candidates Reviewed")
decision = section(text, "## Reuse Decision")
sources = section(text, "## Sources")
urls = re.findall(r"https?://\S+", text)
placeholder_re = re.compile(r"\b(TODO|TBD|fill this|placeholder)\b", re.I)
if not candidates or placeholder_re.search(candidates):
    emit("fail", "research must include non-placeholder Candidates Reviewed")
    raise SystemExit(1)
if not decision or placeholder_re.search(decision):
    emit("fail", "research must include a non-placeholder Reuse Decision")
    raise SystemExit(1)
if not sources or len(urls) < 2:
    emit("fail", "research must include at least two web source URLs")
    raise SystemExit(1)

emit("pass")
PY
}

case "${COMMAND}" in
  init)
    FORCE=0
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --force)
          FORCE=1
          shift
          ;;
        *)
          echo "error: unknown argument: $1" >&2
          usage
          ;;
      esac
    done
    [[ -d "${RUN_DIR}" ]] || {
      echo "error: missing run dir: ${RUN_DIR}" >&2
      exit 1
    }
    if [[ -f "${RESEARCH}" && "${FORCE}" -ne 1 ]]; then
      echo "error: research already exists: ${RESEARCH}" >&2
      exit 1
    fi
    cat > "${RESEARCH}" <<EOF
# ${TASK_ID} Research

## Research Question

What libraries, frameworks, open-source projects, tools, or known implementation
patterns already solve this problem?

## Candidates Reviewed

- TODO: candidate name, URL, fit, constraints.
- TODO: candidate name, URL, fit, constraints.

## Open-Source Patterns

- TODO: summarize how established implementations usually solve this.

## Reuse Decision

TODO: choose reuse, wrap, adapt, or build from scratch. Explain why.

## Sources

- TODO: https://example.com/source-one
- TODO: https://example.com/source-two
EOF
    echo "${RESEARCH}"
    ;;
  save)
    INPUT_FILE=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --file)
          [[ $# -ge 2 ]] || usage
          INPUT_FILE="$2"
          shift 2
          ;;
        *)
          echo "error: unknown argument: $1" >&2
          usage
          ;;
      esac
    done
    [[ -d "${RUN_DIR}" ]] || {
      echo "error: missing run dir: ${RUN_DIR}" >&2
      exit 1
    }
    if [[ -n "${INPUT_FILE}" ]]; then
      [[ -f "${INPUT_FILE}" ]] || {
        echo "error: missing research input file: ${INPUT_FILE}" >&2
        exit 1
      }
      cp "${INPUT_FILE}" "${RESEARCH}"
    elif [[ -n "${HARNESS_RESEARCH_TEXT:-}" ]]; then
      printf '%s\n' "${HARNESS_RESEARCH_TEXT}" > "${RESEARCH}"
    else
      cat > "${RESEARCH}"
    fi
    echo "${RESEARCH}"
    ;;
  status|gate)
    JSON_OUTPUT=0
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --json)
          JSON_OUTPUT=1
          shift
          ;;
        *)
          echo "error: unknown argument: $1" >&2
          usage
          ;;
      esac
    done
    validate_research "${JSON_OUTPUT}"
    ;;
  *)
    echo "error: unknown command: ${COMMAND}" >&2
    usage
    ;;
esac
