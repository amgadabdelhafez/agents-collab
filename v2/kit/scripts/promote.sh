#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: promote.sh <parked-spec|slug> [--mode emergent|planned|investigation|maintenance] [--description text]
USAGE
  exit 2
}

[[ $# -ge 1 ]] || usage

SPEC_ARG="$1"
shift
MODE="emergent"
DESCRIPTION=""
CURRENT=".harness/current-task"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      [[ $# -ge 2 ]] || usage
      MODE="$2"
      shift 2
      ;;
    --description)
      [[ $# -ge 2 ]] || usage
      DESCRIPTION="$2"
      shift 2
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage
      ;;
  esac
done

case "${MODE}" in
  emergent|planned|investigation|maintenance) ;;
  *)
    echo "error: invalid mode: ${MODE}" >&2
    exit 2
    ;;
esac

if [[ -f "${CURRENT}" ]] && [[ -n "$(cat "${CURRENT}")" ]]; then
  echo "error: active task already set: $(cat "${CURRENT}")" >&2
  echo "hint: run './harness done' or './harness park' before promoting an idea" >&2
  exit 1
fi

SPEC_PATH="${SPEC_ARG}"
if [[ "${SPEC_ARG}" != */* && "${SPEC_ARG}" != *.md ]]; then
  SPEC_PATH="specs/${SPEC_ARG}.md"
fi

[[ -f "${SPEC_PATH}" ]] || {
  echo "error: parked spec not found: ${SPEC_PATH}" >&2
  exit 1
}

TASK_ID="$(python3 - "${SPEC_PATH}" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
match = re.search(r"^id:\s*([a-z][a-z0-9-]*)\s*$", text, re.MULTILINE)
task_id = match.group(1) if match else path.stem
if not re.match(r"^[a-z][a-z0-9-]*$", task_id):
    raise SystemExit(f"error: parked spec id must be kebab-case: {task_id}")
print(task_id)
PY
)"

if [[ -z "${DESCRIPTION}" ]]; then
  DESCRIPTION="$(python3 - "${SPEC_PATH}" <<'PY'
import pathlib
import re
import sys

text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
match = re.search(r"^## Capture\s*\n+(.*?)(?:\n## |\Z)", text, re.S | re.M)
if match:
    capture = " ".join(match.group(1).strip().split())
    print(capture[:240])
PY
)"
fi

task_args=("${TASK_ID}" --mode "${MODE}")
if [[ -n "${DESCRIPTION}" ]]; then
  task_args+=(--description "${DESCRIPTION}")
fi
"${SCRIPT_DIR}/task.sh" "${task_args[@]}"

PROMOTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
python3 - "${TASK_ID}" "${SPEC_PATH}" "${PROMOTED_AT}" <<'PY'
import json
import pathlib
import sys

task_id, spec_path, promoted_at = sys.argv[1:4]
run = pathlib.Path("runs") / task_id
spec = pathlib.Path(spec_path)
idea_copy = run / "parked-idea.md"
idea_copy.write_text(spec.read_text(encoding="utf-8"), encoding="utf-8")

meta_path = run / "meta.json"
meta = json.loads(meta_path.read_text(encoding="utf-8"))
meta["promoted_from"] = str(spec)
meta["promoted_at"] = promoted_at
meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

memory = run / "memory" / "002-promoted-parked-idea.md"
memory.write_text(f"""---
seq: 002
date: {promoted_at}
trigger: promote
topic: promoted parked idea
---

## Decided

- Promoted parked idea `{spec}` into active task `{task_id}`.

## Still open

- Implement the promoted idea and complete normal verification.

## Where we are

- Original parked idea was copied to `runs/{task_id}/parked-idea.md`.
""", encoding="utf-8")
PY

if [[ -x "${SCRIPT_DIR}/tasks-index.sh" ]]; then
  "${SCRIPT_DIR}/tasks-index.sh" refresh "${TASK_ID}" >/dev/null
fi

python3 - ".harness/parked-ideas.jsonl" "${TASK_ID}" "${PROMOTED_AT}" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
task_id = sys.argv[2]
promoted_at = sys.argv[3]
if not path.exists():
    raise SystemExit(0)
rows = []
for line in path.read_text(encoding="utf-8").splitlines():
    if not line.strip():
        continue
    row = json.loads(line)
    if row.get("id") == task_id:
        row["status"] = "promoted"
        row["promoted_at"] = promoted_at
        row["run_dir"] = f"runs/{task_id}"
    rows.append(row)
path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
PY

echo "Created runs/${TASK_ID}, mode=${MODE}"
