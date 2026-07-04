#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: done.sh <id>
USAGE
  exit 2
}

[[ $# -eq 1 ]] || usage

TASK_ID="$1"
RUN_DIR="runs/${TASK_ID}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -d "${RUN_DIR}" ]]; then
  echo "error: run does not exist: ${RUN_DIR}" >&2
  exit 1
fi

"${SCRIPT_DIR}/stop-gate.sh" "${TASK_ID}" >/dev/null

if [[ -x "${SCRIPT_DIR}/post-task.sh" ]]; then
  "${SCRIPT_DIR}/post-task.sh" "${TASK_ID}" >&2
fi

ENDED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
mkdir -p "specs"

python3 - "${TASK_ID}" "${RUN_DIR}" "specs/${TASK_ID}.md" "${ENDED_AT}" <<'PY'
import json
import pathlib
import re
import sys

task_id, run_dir, spec_path, ended_at = sys.argv[1:5]
run = pathlib.Path(run_dir)
spec = pathlib.Path(spec_path)
meta_path = run / "meta.json"
task_log_path = run / "task-log.md"
memory_dir = run / "memory"

meta = json.loads(meta_path.read_text(encoding="utf-8"))
if meta.get("status") == "done":
    raise SystemExit(f"error: task already done: {task_id}")
mode = meta.get("mode", "unknown")

def section(text: str, heading: str) -> str:
    lines = text.splitlines()
    collected = []
    active = False
    for line in lines:
        if line.strip() == heading:
            active = True
            continue
        if active and line.startswith("## "):
            break
        if active:
            collected.append(line)
    return "\n".join(collected).strip()

def section_or_placeholder(value: str) -> str:
    return value.strip() if value.strip() else "_No entries recorded._"

if mode == "investigation":
    notes_path = run / "notes.md"
    if not notes_path.exists():
        raise SystemExit(f"error: missing investigation notes: {notes_path}")
    notes = notes_path.read_text(encoding="utf-8")
    findings = section(notes, "## Findings")
    if not findings.strip():
        raise SystemExit("error: investigation notes Findings is empty")
    what_built = findings.strip()
else:
    task_log = task_log_path.read_text(encoding="utf-8")
    what_changed = section(task_log, "## What I changed")
    if not what_changed.strip():
        raise SystemExit("error: task-log What I changed is empty")
    what_built = section_or_placeholder(what_changed)

memory_files = sorted(memory_dir.glob("[0-9][0-9][0-9]-*.md"))
if not memory_files:
    raise SystemExit(f"error: no memory files found for {task_id}")

decisions = []
trajectory = []
for path in memory_files:
    text = path.read_text(encoding="utf-8")
    decided = section(text, "## Decided")
    if decided:
        decisions.append(decided)

    seq = path.name[:3]
    topic_match = re.search(r"^topic:\s*(.*)$", text, re.MULTILINE)
    date_match = re.search(r"^date:\s*(.*)$", text, re.MULTILINE)
    topic = topic_match.group(1).strip() if topic_match else path.stem[4:]
    date = date_match.group(1).strip() if date_match else "unknown-date"
    trajectory.append(f"- {seq} - {topic} ({date})")

final_text = memory_files[-1].read_text(encoding="utf-8")
open_items = section_or_placeholder(section(final_text, "## Still open"))
decision_text = section_or_placeholder("\n\n".join(decisions))
trajectory_text = "\n".join(trajectory)
spec.write_text(f"""# {task_id}

Task completed {ended_at}, mode {mode}.

## What was built

{what_built}

## Decisions made

{decision_text}

## Open items at completion

{open_items}

## Trajectory

{trajectory_text}
""", encoding="utf-8")

meta["status"] = "done"
meta["ended_at"] = ended_at
meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
PY

CURRENT_TASK=".harness/current-task"
if [[ -x "v2/kit/scripts/tasks-index.sh" ]]; then
  "v2/kit/scripts/tasks-index.sh" mark-done "${TASK_ID}" "specs/${TASK_ID}.md" >/dev/null
fi

if [[ -x "v2/kit/scripts/coordination.sh" ]]; then
  "v2/kit/scripts/coordination.sh" write "${TASK_ID}" --intent done >/dev/null
fi

if [[ -f "${CURRENT_TASK}" ]] && [[ "$(cat "${CURRENT_TASK}")" == "${TASK_ID}" ]]; then
  rm -f "${CURRENT_TASK}"
fi

echo "specs/${TASK_ID}.md"
