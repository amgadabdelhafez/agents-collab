#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: regression-harvest.sh <task-id>
USAGE
  exit 2
}

[[ $# -eq 1 ]] || usage

TASK_ID="$1"
RUN_DIR="runs/${TASK_ID}"
TASK_LOG="${RUN_DIR}/task-log.md"
EVAL_JSON="${RUN_DIR}/eval.json"
ARTIFACT_DIR="${RUN_DIR}/artifacts/regression-harvest"
OUT_DIR="evals/regression"

mkdir -p "${ARTIFACT_DIR}" "${OUT_DIR}"

if [[ ! -f "${TASK_LOG}" ]]; then
  echo "regression harvest skipped: missing ${TASK_LOG}" >&2
  exit 0
fi

python3 - "${TASK_ID}" "${TASK_LOG}" "${EVAL_JSON}" "${ARTIFACT_DIR}" "${OUT_DIR}" <<'PY'
import json
import pathlib
import re
import sys
from datetime import datetime, timezone

task_id, task_log_path, eval_path, artifact_dir, out_dir = sys.argv[1:6]
task_log = pathlib.Path(task_log_path)
eval_json = pathlib.Path(eval_path)
artifact = pathlib.Path(artifact_dir)
out = pathlib.Path(out_dir)
text = task_log.read_text(encoding="utf-8")
changed = section_text = ""

def section(markdown: str, heading: str) -> str:
    lines = markdown.splitlines()
    collected = []
    active = False
    for line in lines:
        if line.strip().lower() == heading.lower():
            active = True
            continue
        if active and line.startswith("## "):
            break
        if active:
            collected.append(line)
    return "\n".join(collected).strip()

changed = section(text, "## What I changed")
signal_text = changed or text
signal_text = re.sub(r"```.*?```", "", signal_text, flags=re.S)
signal_text = re.sub(r"`[^`]*`", "", signal_text)
lower = signal_text.lower()

def regression_markers(markdown: str) -> dict[str, list[str]]:
    markers: dict[str, list[str]] = {}
    pattern = re.compile(r"^Regression(?:\s+([A-Za-z][A-Za-z -]*))?:\s*(.*?)\s*$", re.I)
    for raw in markdown.splitlines():
        match = pattern.match(raw.strip())
        if not match:
            continue
        key = (match.group(1) or "enabled").strip().lower().replace(" ", "_").replace("-", "_")
        markers.setdefault(key, []).append(match.group(2).strip())
    return markers

markers = regression_markers(text)
regression_values = [value.lower() for value in markers.get("enabled", [])]
explicit_yes = any(value in {"yes", "true", "1"} for value in regression_values)
explicit_no = any(value in {"no", "false", "0", "skip", "skipped"} for value in regression_values)

bug_signals = [
    r"\bbug\b",
    r"\bfix(?:e[ds])?\b",
    r"\bregression\b",
    r"\bfailure\b",
    r"\bcrash(?:e[ds])?\b",
    r"\bbroken\b",
]
fix_signal = bool(re.search(r"(?<![-/])\bfix(?:e[ds]|ing)?\b", lower))
problem_signal = any(re.search(pattern, lower) for pattern in bug_signals if "fix" not in pattern)
has_bug_fix = False if explicit_no else ((fix_signal and problem_signal) or explicit_yes)

def slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = re.sub(r"-+", "-", value).strip("-")
    if value.endswith("-fix"):
        value = value[:-4]
    if value.startswith("fix-"):
        value = value[4:]
    if not value:
        value = task_id
    return value[:80].strip("-")

def first_matching_lines(markdown: str, patterns: list[str]) -> list[str]:
    rows = []
    for raw in markdown.splitlines():
        line = raw.strip()
        if not line:
            continue
        lowered = line.lower()
        if any(re.search(pattern, lowered) for pattern in patterns):
            rows.append(line)
    return rows[:8]

created_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
harvest_path = artifact / "harvest.json"
prompt_path = artifact / "prompt.md"

if not has_bug_fix:
    harvest_path.write_text(json.dumps({
        "task_id": task_id,
        "status": "skipped",
        "reason": "no bug-fix signal in task log",
        "created_at": created_at,
    }, indent=2) + "\n", encoding="utf-8")
    print("regression harvest skipped: no bug-fix signal")
    raise SystemExit(0)

bug_id = slugify(markers.get("id", [task_id])[0] or task_id)
regression_path = out / f"{bug_id}.md"

why = section(text, "## Why")
notes = section(text, "## Notes")
symptom_lines = markers.get("symptom", []) or first_matching_lines(text, [r"symptom", r"bug", r"failure", r"crash", r"broken", r"regression"])
test_lines = markers.get("guard", []) or first_matching_lines(text, [r"\btest\b", r"\btests/", r"\bspec\b", r"\bguard\b", r"\bverify\b"])

eval_data = {}
if eval_json.exists():
    eval_data = json.loads(eval_json.read_text(encoding="utf-8"))
dimensions = eval_data.get("dimensions", {})
artifacts = []
for dim_name, dim in sorted(dimensions.items()):
    artifact_path = dim.get("artifact")
    if artifact_path:
        artifacts.append(f"- `{dim_name}`: `{artifact_path}` ({dim.get('status', 'unknown')})")

symptom_text = "\n".join(f"- {line}" for line in symptom_lines) if symptom_lines else (
    why or changed or "_No explicit symptom recorded; inspect the source task log._"
)
guard_text = "\n".join(f"- {line}" for line in test_lines) if test_lines else "_No explicit test line recorded._"
artifact_text = "\n".join(artifacts) if artifacts else "_No eval artifacts recorded._"

prompt_path.write_text(f"""# Regression Harvest Prompt

Task `{task_id}` appears to record a bug fix.

Review `evals/regression/{bug_id}.md` and convert it into a runnable regression
check when the project has a concrete eval harness for this bug class.
""", encoding="utf-8")

if regression_path.exists():
    status = "existing"
else:
    regression_path.write_text(f"""# Regression Eval: {bug_id}

Generated: {created_at}
Source task: `{task_id}`
Status: draft

## Failure Symptom

{symptom_text}

## Guard Evidence

{guard_text}

## Verification Artifacts

{artifact_text}

## Source Task Notes

{notes or "_No notes recorded._"}

## Next Step

Turn this draft into an executable regression check and wire it into the
appropriate verification dimension.
""", encoding="utf-8")
    status = "created"

harvest_path.write_text(json.dumps({
    "task_id": task_id,
    "status": status,
    "bug_id": bug_id,
    "regression_path": str(regression_path),
    "prompt_path": str(prompt_path),
    "created_at": created_at,
    "markers": markers,
    "symptom_lines": symptom_lines,
    "test_lines": test_lines,
}, indent=2) + "\n", encoding="utf-8")

print(f"regression harvest {status}: {regression_path}")
PY
