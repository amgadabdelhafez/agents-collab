#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: session-export.sh [--repo <path>] [--source <path>]... [--out <dir>|--file <path>] [--include-global] [--no-filter] [--limit n] [--json]
USAGE
  exit 2
}

REPO="."
OUT_DIR="sessions"
OUT_FILE=""
INCLUDE_GLOBAL=0
FILTER_TO_REPO=1
LIMIT="200"
JSON_OUTPUT=0
SOURCES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      [[ $# -ge 2 ]] || usage
      REPO="$2"
      shift 2
      ;;
    --source)
      [[ $# -ge 2 ]] || usage
      SOURCES+=("$2")
      shift 2
      ;;
    --out)
      [[ $# -ge 2 ]] || usage
      OUT_DIR="$2"
      shift 2
      ;;
    --file)
      [[ $# -ge 2 ]] || usage
      OUT_FILE="$2"
      shift 2
      ;;
    --include-global)
      INCLUDE_GLOBAL=1
      shift
      ;;
    --no-filter)
      FILTER_TO_REPO=0
      shift
      ;;
    --limit)
      [[ $# -ge 2 ]] || usage
      LIMIT="$2"
      shift 2
      ;;
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

case "${LIMIT}" in
  *[!0-9]*|"")
    echo "error: --limit must be a positive integer" >&2
    exit 2
    ;;
esac
if [[ "${LIMIT}" -lt 1 ]]; then
  echo "error: --limit must be at least 1" >&2
  exit 2
fi

[[ -d "${REPO}" ]] || {
  echo "error: repo does not exist: ${REPO}" >&2
  exit 1
}

REPO_ABS="$(cd "${REPO}" && pwd)"
if [[ -n "${OUT_FILE}" ]]; then
  case "${OUT_FILE}" in
    /*) ;;
    *) OUT_FILE="${REPO_ABS}/${OUT_FILE}" ;;
  esac
  mkdir -p "$(dirname "${OUT_FILE}")"
else
  case "${OUT_DIR}" in
    /*) ;;
    *) OUT_DIR="${REPO_ABS}/${OUT_DIR}" ;;
  esac
  mkdir -p "${OUT_DIR}"
  OUT_FILE="${OUT_DIR}/$(date -u +"%Y%m%d-%H%M%S")-session-export.jsonl"
fi

python3 - "${REPO_ABS}" "${OUT_FILE}" "${INCLUDE_GLOBAL}" "${FILTER_TO_REPO}" "${LIMIT}" "${HOME:-}" "${JSON_OUTPUT}" ${SOURCES[@]+"${SOURCES[@]}"} <<'PY'
import json
import os
import pathlib
import re
import sys
from datetime import datetime, timezone

repo = pathlib.Path(sys.argv[1]).resolve()
out_file = pathlib.Path(sys.argv[2]).resolve()
include_global = sys.argv[3] == "1"
filter_to_repo = sys.argv[4] == "1"
limit = int(sys.argv[5])
home = pathlib.Path(sys.argv[6]).expanduser() if sys.argv[6] else None
json_output = sys.argv[7] == "1"
cli_sources = sys.argv[8:]
env_sources = [item for item in os.environ.get("HARNESS_SESSION_EXPORT_SOURCES", "").split(os.pathsep) if item]
exported_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def die(message: str, code: int = 1) -> None:
    raise SystemExit(f"error: {message}")

def read_text(path: pathlib.Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""

def load_json(path: pathlib.Path, fallback=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback

def normalize_source(path_text: str) -> pathlib.Path:
    path = pathlib.Path(path_text).expanduser()
    if not path.is_absolute():
        path = (pathlib.Path.cwd() / path).resolve()
    return path

def is_relative_to(path: pathlib.Path, parent: pathlib.Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except Exception:
        return False

def display_path(path: pathlib.Path) -> str:
    try:
        return str(path.resolve().relative_to(repo))
    except Exception:
        return str(path)

def repo_fingerprints():
    repo_text = str(repo)
    return [
        repo_text,
        repo_text.replace("/", "-").strip("-"),
        repo_text.replace("/", "_").strip("_"),
        repo.name,
    ]

def matches_repo(path: pathlib.Path, fingerprints) -> bool:
    if is_relative_to(path, repo):
        return True
    haystack = f"{path}\n{read_text(path)[:80000]}"
    return any(item and item in haystack for item in fingerprints)

def normalize_role(value):
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in {"user", "human"} or text.startswith("human"):
        return "human"
    if text in {"assistant", "agent", "claude", "codex"} or text.startswith("assistant"):
        return "assistant"
    return None

def detect_role(record):
    if not isinstance(record, dict):
        return None
    for key in ("role", "speaker", "actor", "sender"):
        role = normalize_role(record.get(key))
        if role:
            return role
    author = record.get("author")
    if isinstance(author, dict):
        role = normalize_role(author.get("role") or author.get("type") or author.get("name"))
        if role:
            return role
    else:
        role = normalize_role(author)
        if role:
            return role
    role = normalize_role(record.get("type"))
    if role:
        return role
    nested = record.get("message")
    if isinstance(nested, dict):
        return detect_role(nested)
    return None

def text_from_content(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        parts = [text_from_content(item) for item in value]
        return "\n".join(part for part in parts if part.strip())
    if isinstance(value, dict):
        if value.get("type") == "text" and "text" in value:
            return text_from_content(value["text"])
        for key in ("content", "text", "message", "prompt", "input"):
            if key in value:
                text = text_from_content(value[key])
                if text.strip():
                    return text
    return ""

def message_metadata(record):
    if not isinstance(record, dict):
        return {}
    meta = {}
    for key in ("session_id", "sessionId", "conversation_id", "conversationId", "turn", "turn_index", "uuid", "cwd"):
        if key in record:
            meta[key] = record[key]
    for key in ("created_at", "createdAt", "timestamp", "time", "date"):
        if key in record:
            meta["timestamp"] = record[key]
            break
    return meta

def walk_messages(value, source, inherited_meta=None):
    inherited_meta = inherited_meta or {}
    if isinstance(value, list):
        for item in value:
            yield from walk_messages(item, source, inherited_meta)
        return
    if not isinstance(value, dict):
        return
    meta = dict(inherited_meta)
    meta.update(message_metadata(value))
    role = detect_role(value)
    text = text_from_content(value)
    if role and text.strip():
        yield {
            "schema_version": 1,
            "exported_at": exported_at,
            "role": "user" if role == "human" else role,
            "content": re.sub(r"\n{3,}", "\n\n", text.strip()),
            "source": source,
            "metadata": meta,
        }
    for key in ("messages", "turns", "events", "entries", "items", "children"):
        child = value.get(key)
        if isinstance(child, (list, dict)):
            yield from walk_messages(child, source, meta)

def candidate_files(root: pathlib.Path):
    if root.is_file() and root.suffix in {".json", ".jsonl"}:
        return [root]
    if not root.is_dir():
        return []
    return sorted(set(root.rglob("*.json")) | set(root.rglob("*.jsonl")))

source_roots = []
for item in cli_sources + env_sources:
    source_roots.append({"path": normalize_source(item), "kind": "explicit"})
if include_global and home:
    for rel in [".claude/projects", ".codex/sessions", ".config/claude/projects", "Library/Application Support/Claude/projects"]:
        source_roots.append({"path": home / rel, "kind": "global"})
if not source_roots:
    die("provide at least one --source or use --include-global")

fingerprints = repo_fingerprints()
seen_files = set()
seen_messages = set()
messages = []
sources = []
files_seen = 0
files_selected = 0

for source in source_roots:
    root = source["path"]
    record = {
        "path": str(root),
        "kind": source["kind"],
        "exists": root.exists(),
        "files_seen": 0,
        "files_selected": 0,
    }
    for path in candidate_files(root):
        resolved = str(path.resolve())
        if resolved in seen_files or path.resolve() == out_file:
            continue
        seen_files.add(resolved)
        record["files_seen"] += 1
        files_seen += 1
        if filter_to_repo and not matches_repo(path, fingerprints):
            continue
        record["files_selected"] += 1
        files_selected += 1
        if path.suffix == ".jsonl":
            for line_no, line in enumerate(read_text(path).splitlines(), start=1):
                if not line.strip():
                    continue
                try:
                    data = json.loads(line)
                except Exception:
                    continue
                for message in walk_messages(data, f"{display_path(path)}:{line_no}"):
                    key = (message["role"], message["content"], message["source"])
                    if key not in seen_messages:
                        seen_messages.add(key)
                        messages.append(message)
                        if len(messages) >= limit:
                            break
                if len(messages) >= limit:
                    break
        else:
            data = load_json(path, None)
            if data is not None:
                for message in walk_messages(data, display_path(path)):
                    key = (message["role"], message["content"], message["source"])
                    if key not in seen_messages:
                        seen_messages.add(key)
                        messages.append(message)
                        if len(messages) >= limit:
                            break
        if len(messages) >= limit:
            break
    sources.append(record)
    if len(messages) >= limit:
        break

if not messages:
    die("no matching user/assistant messages found in session sources")

out_file.parent.mkdir(parents=True, exist_ok=True)
with out_file.open("w", encoding="utf-8") as handle:
    for message in messages:
        handle.write(json.dumps(message, ensure_ascii=False, sort_keys=True) + "\n")

summary = {
    "schema_version": 1,
    "exported_at": exported_at,
    "repo": str(repo),
    "output": str(out_file),
    "messages": len(messages),
    "files_seen": files_seen,
    "files_selected": files_selected,
    "filter_to_repo": filter_to_repo,
    "sources": sources,
}
if json_output:
    print(json.dumps(summary, indent=2))
else:
    print(out_file)
PY
