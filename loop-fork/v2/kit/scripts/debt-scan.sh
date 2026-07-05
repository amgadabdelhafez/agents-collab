#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: debt-scan.sh <task-id> [--config .harness/config.json]
USAGE
  exit 2
}

[[ $# -ge 1 ]] || usage

TASK_ID="$1"
shift
CONFIG=".harness/config.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      [[ $# -ge 2 ]] || usage
      CONFIG="$2"
      shift 2
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage
      ;;
  esac
done

RUN_DIR="runs/${TASK_ID}"
ARTIFACT_DIR="${RUN_DIR}/artifacts/debt"
BASELINE="${ARTIFACT_DIR}/baseline-loc.json"
SCAN="${ARTIFACT_DIR}/scan.json"
LOG="${ARTIFACT_DIR}/scan.log"
REGISTER="debt/register.jsonl"
mkdir -p "${ARTIFACT_DIR}" "debt"

if [[ ! -f "${BASELINE}" ]]; then
  {
    echo "debt scan skipped: missing baseline ${BASELINE}"
  } | tee "${LOG}" >&2
  python3 - "${TASK_ID}" "${SCAN}" <<'PY'
import json
import pathlib
import sys
from datetime import datetime, timezone

task_id, scan_path = sys.argv[1:3]
pathlib.Path(scan_path).write_text(json.dumps({
    "task_id": task_id,
    "scanned_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "status": "skipped",
    "reason": "missing baseline",
    "findings": [],
}, indent=2) + "\n", encoding="utf-8")
PY
  exit 0
fi

python3 - "${TASK_ID}" "${CONFIG}" "${BASELINE}" "${SCAN}" "${REGISTER}" <<'PY' | tee "${LOG}" >&2
import json
import pathlib
import sys
from datetime import datetime, timezone

task_id, config_path, baseline_path, scan_path, register_path = sys.argv[1:6]

DEFAULT_EXTENSIONS = [
    ".bash", ".c", ".cc", ".cpp", ".css", ".go", ".h", ".hpp", ".html",
    ".java", ".js", ".jsx", ".kt", ".m", ".mm", ".php", ".py", ".rb",
    ".rs", ".sh", ".swift", ".ts", ".tsx",
]
DEFAULT_EXCLUDES = {
    ".cache", ".git", ".harness", ".mypy_cache", ".next", ".pytest_cache",
    ".tox", ".turbo", ".venv", "__pycache__", "build", "coverage", "debt",
    "dist", "external", "logs", "node_modules", "reports", "runs", "specs",
    "target", "third_party", "tmp", "vendor", "venv",
}
DEFAULT_ROOTS = [
    "src", "app", "lib", "scripts", "packages", "components", "pages",
    "server", "client", "cmd", "internal", "v2/kit/scripts",
]

def load_json(path: pathlib.Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))

def scan_roots(config: dict) -> list[pathlib.Path]:
    if "debt_scan_paths" in config:
        return [pathlib.Path(item) for item in config.get("debt_scan_paths", [])]
    existing = [pathlib.Path(item) for item in DEFAULT_ROOTS if pathlib.Path(item).exists()]
    return existing or [pathlib.Path(".")]

def is_under_excluded_dir(path: pathlib.Path, excludes: set[str]) -> bool:
    return any(part in excludes for part in path.parts)

def count_lines(path: pathlib.Path) -> int | None:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return None
    except OSError:
        return None
    if not text:
        return 0
    return len(text.splitlines())

config = load_json(pathlib.Path(config_path), {})
threshold = int(config.get("debt_loc_growth_threshold", 100))
roots = scan_roots(config)
extensions = set(config.get("debt_file_extensions", DEFAULT_EXTENSIONS))
excludes = set(config.get("debt_exclude_dirs", list(DEFAULT_EXCLUDES)))
baseline = load_json(pathlib.Path(baseline_path), {"files": {}})
baseline_files = baseline.get("files", {})

current: dict[str, int] = {}
for root in roots:
    if not root.exists():
        continue
    candidates = [root] if root.is_file() else root.rglob("*")
    for path in candidates:
        if not path.is_file():
            continue
        rel = path.relative_to(pathlib.Path.cwd()) if path.is_absolute() else path
        rel = pathlib.Path(str(rel))
        if is_under_excluded_dir(rel, excludes):
            continue
        if path.suffix not in extensions:
            continue
        loc = count_lines(path)
        if loc is None:
            continue
        current[str(rel)] = loc

scanned_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
findings = []
for file_path, after_loc in sorted(current.items()):
    before_loc = baseline_files.get(file_path, {}).get("loc", 0)
    delta = after_loc - before_loc
    if delta >= threshold:
        findings.append({
            "ts": scanned_at,
            "task_id": task_id,
            "signal": "loc_growth",
            "file": file_path,
            "before_loc": before_loc,
            "after_loc": after_loc,
            "delta_loc": delta,
            "threshold": threshold,
            "severity": "indicator",
        })

scan = {
    "task_id": task_id,
    "scanned_at": scanned_at,
    "status": "pass",
    "threshold": threshold,
    "findings": findings,
}
pathlib.Path(scan_path).write_text(json.dumps(scan, indent=2) + "\n", encoding="utf-8")

register = pathlib.Path(register_path)
existing_fingerprints = set()
if register.exists():
    for line in register.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        existing_fingerprints.add((row.get("task_id"), row.get("signal"), row.get("file"), row.get("after_loc")))

appended = 0
with register.open("a", encoding="utf-8") as f:
    for row in findings:
        fingerprint = (row["task_id"], row["signal"], row["file"], row["after_loc"])
        if fingerprint in existing_fingerprints:
            continue
        f.write(json.dumps(row) + "\n")
        appended += 1

print(f"debt scan completed: {len(findings)} finding(s), {appended} appended")
PY
