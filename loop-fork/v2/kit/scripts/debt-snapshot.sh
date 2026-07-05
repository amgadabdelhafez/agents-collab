#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: debt-snapshot.sh <task-id> [--config .harness/config.json]
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
mkdir -p "${ARTIFACT_DIR}"

python3 - "${TASK_ID}" "${CONFIG}" "${ARTIFACT_DIR}/baseline-loc.json" <<'PY'
import json
import pathlib
import sys
from datetime import datetime, timezone

task_id, config_path, out_path = sys.argv[1:4]

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

def load_config(path: pathlib.Path) -> dict:
    if not path.exists():
        return {}
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

config = load_config(pathlib.Path(config_path))
roots = scan_roots(config)
extensions = set(config.get("debt_file_extensions", DEFAULT_EXTENSIONS))
excludes = set(config.get("debt_exclude_dirs", list(DEFAULT_EXCLUDES)))

files: dict[str, dict[str, int]] = {}
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
        files[str(rel)] = {"loc": loc}

out = pathlib.Path(out_path)
out.write_text(json.dumps({
    "task_id": task_id,
    "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "files": dict(sorted(files.items())),
}, indent=2) + "\n", encoding="utf-8")
print(f"debt baseline captured: {out}")
PY
