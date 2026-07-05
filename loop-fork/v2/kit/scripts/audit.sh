#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: audit.sh <security|accessibility|performance> [--path <path>...] [--task <task-id>] [--no-tracker]
USAGE
  exit 2
}

[[ $# -ge 1 ]] || usage

KIND="$1"
shift
TASK_ID=""
PATHS=()
USE_TRACKER=1
CONFIG=".harness/config.json"

case "${KIND}" in
  security|accessibility|performance) ;;
  *)
    echo "error: unknown audit kind: ${KIND}" >&2
    usage
    ;;
esac

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path)
      [[ $# -ge 2 ]] || usage
      PATHS+=("$2")
      shift 2
      ;;
    --task)
      [[ $# -ge 2 ]] || usage
      TASK_ID="$2"
      shift 2
      ;;
    --no-tracker)
      USE_TRACKER=0
      shift
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage
      ;;
  esac
done

if [[ "${#PATHS[@]}" -eq 0 ]]; then
  PATHS=(".")
fi

if [[ -z "${TASK_ID}" && -f ".harness/current-task" ]]; then
  TASK_ID="$(cat .harness/current-task)"
fi

if [[ -n "${TASK_ID}" ]]; then
  OUT_DIR="runs/${TASK_ID}/artifacts/audits"
else
  OUT_DIR="reports/audits"
fi
mkdir -p "${OUT_DIR}" "debt"

python3 - "${KIND}" "${TASK_ID}" "${OUT_DIR}" "${USE_TRACKER}" "${CONFIG}" "${PATHS[@]}" <<'PY'
import json
import pathlib
import re
import subprocess
import sys
from datetime import datetime, timezone

kind, task_id, out_dir, use_tracker, config_path, *roots = sys.argv[1:]
use_tracker = use_tracker == "1"
out = pathlib.Path(out_dir)
created_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
config = {}
config_file = pathlib.Path(config_path)
if config_file.exists():
    config = json.loads(config_file.read_text(encoding="utf-8"))

EXCLUDES = {".git", ".harness", ".venv", "__pycache__", "debt", "node_modules", "runs", "specs", "target", "venv"}
TEXT_SUFFIXES = {".bash", ".css", ".html", ".js", ".jsx", ".json", ".md", ".py", ".sh", ".ts", ".tsx", ".txt", ".yaml", ".yml"}

def iter_files():
    for root_item in roots:
        root = pathlib.Path(root_item)
        if not root.exists():
            continue
        candidates = [root] if root.is_file() else root.rglob("*")
        for path in candidates:
            if not path.is_file():
                continue
            rel = path.relative_to(pathlib.Path.cwd()) if path.is_absolute() else path
            rel = pathlib.Path(str(rel))
            if any(part in EXCLUDES for part in rel.parts):
                continue
            if path.suffix and path.suffix not in TEXT_SUFFIXES:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            yield str(rel), text

def add_finding(findings, file_path, line, rule, title, detail):
    findings.append({
        "rule": rule,
        "title": title,
        "file": file_path,
        "line": line,
        "detail": detail,
        "severity": "medium",
    })

findings = []
for file_path, text in iter_files():
    lines = text.splitlines()
    if kind == "security":
        for index, line in enumerate(lines, start=1):
            if re.search(r"\b(password|api[_-]?key|secret|token)\b\s*[:=]\s*['\"][^'\"]{4,}", line, re.I):
                add_finding(findings, file_path, index, "hardcoded-secret-like-value", "Secret-like value in source", "A credential-looking assignment is present in source text.")
            if re.search(r"curl\b.*\|\s*(sh|bash)\b", line):
                add_finding(findings, file_path, index, "curl-pipe-shell", "Remote script piped to shell", "Download-and-execute shell patterns should be reviewed.")
    elif kind == "accessibility":
        for match in re.finditer(r"<img\b(?![^>]*\balt=)[^>]*>", text, re.I):
            line = text[:match.start()].count("\n") + 1
            add_finding(findings, file_path, line, "img-missing-alt", "Image missing alt text", "Images need alt text or explicit decorative handling.")
        for match in re.finditer(r"<button\b[^>]*>\s*</button>", text, re.I):
            line = text[:match.start()].count("\n") + 1
            add_finding(findings, file_path, line, "empty-button", "Button has no accessible label", "Buttons need visible text or an accessible label.")
    elif kind == "performance":
        threshold = int(config.get("audit_large_file_loc_threshold", 1000))
        loc = len(lines)
        if loc >= threshold:
            add_finding(findings, file_path, 1, "large-file", "Large file crosses LOC threshold", f"{loc} lines crosses threshold {threshold}.")

report_path = out / f"{kind}.md"
json_path = out / f"{kind}.json"
json_path.write_text(json.dumps({
    "kind": kind,
    "task_id": task_id or None,
    "created_at": created_at,
    "finding_count": len(findings),
    "findings": findings,
}, indent=2) + "\n", encoding="utf-8")

if findings:
    body = "\n".join(
        f"- [{item['rule']}] `{item['file']}:{item['line']}`: {item['title']} - {item['detail']}"
        for item in findings
    )
else:
    body = "_No findings._"
report_path.write_text(f"""# {kind.title()} Audit

Generated: {created_at}
Task: {task_id or 'none'}
Findings: {len(findings)}

## Findings

{body}
""", encoding="utf-8")

debt_path = pathlib.Path("debt/register.jsonl")
with debt_path.open("a", encoding="utf-8") as f:
    for item in findings:
        f.write(json.dumps({
            "ts": created_at,
            "task_id": task_id or None,
            "signal": f"audit_{kind}",
            "rule": item["rule"],
            "file": item["file"],
            "line": item["line"],
            "severity": item["severity"],
            "artifact": str(report_path),
        }) + "\n")

tracker_results = []
if use_tracker:
    tracker = pathlib.Path("v2/kit/scripts/tracker.sh")
    if tracker.exists():
        for item in findings:
            title = f"{kind}: {item['title']}"
            result = subprocess.run(
                [str(tracker), "create", "--title", title, "--body", item["detail"], "--artifact", str(report_path), "--label", f"audit:{kind}"] + (["--task", task_id] if task_id else []),
                text=True,
                capture_output=True,
                check=False,
            )
            tracker_results.append({
                "returncode": result.returncode,
                "stdout": result.stdout.strip(),
                "stderr": result.stderr.strip(),
            })

(out / f"{kind}-tracker.json").write_text(json.dumps({
    "kind": kind,
    "results": tracker_results,
}, indent=2) + "\n", encoding="utf-8")
print(str(report_path))
PY
