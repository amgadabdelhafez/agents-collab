#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: retrospect.sh [--repo <path>] [--since <duration>] [--out <dir>] [--query-file <path>] [--semantic] [--llm-cmd <command>] [--content-max-chars <n>] [--session-dir <path>] [--include-global-sessions] [--pickbrain-dump] [--pickbrain-dump-window <n>]
USAGE
  exit 2
}

REPO="."
SINCE=""
OUT=""
QUERY_FILE=""
SEMANTIC=0
LLM_CMD="${HARNESS_RETROSPECT_LLM_CMD:-}"
CONTENT_MAX_CHARS="80000"
SESSION_DIRS=()
INCLUDE_GLOBAL_SESSIONS=0
PICKBRAIN_DUMP=0
PICKBRAIN_DUMP_WINDOW="2"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      [[ $# -ge 2 ]] || usage
      REPO="$2"
      shift 2
      ;;
    --since)
      [[ $# -ge 2 ]] || usage
      SINCE="$2"
      shift 2
      ;;
    --out)
      [[ $# -ge 2 ]] || usage
      OUT="$2"
      shift 2
      ;;
    --query-file)
      [[ $# -ge 2 ]] || usage
      QUERY_FILE="$2"
      shift 2
      ;;
    --semantic)
      SEMANTIC=1
      shift
      ;;
    --llm-cmd)
      [[ $# -ge 2 ]] || usage
      LLM_CMD="$2"
      SEMANTIC=1
      shift 2
      ;;
    --content-max-chars)
      [[ $# -ge 2 ]] || usage
      CONTENT_MAX_CHARS="$2"
      shift 2
      ;;
    --session-dir)
      [[ $# -ge 2 ]] || usage
      SESSION_DIRS+=("$2")
      shift 2
      ;;
    --include-global-sessions)
      INCLUDE_GLOBAL_SESSIONS=1
      shift
      ;;
    --pickbrain-dump)
      PICKBRAIN_DUMP=1
      SEMANTIC=1
      shift
      ;;
    --pickbrain-dump-window)
      [[ $# -ge 2 ]] || usage
      PICKBRAIN_DUMP_WINDOW="$2"
      shift 2
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage
      ;;
  esac
done

case "${CONTENT_MAX_CHARS}" in
  *[!0-9]*|"")
    echo "error: --content-max-chars must be a positive integer" >&2
    exit 2
    ;;
esac
if [[ "${CONTENT_MAX_CHARS}" -lt 1000 ]]; then
  echo "error: --content-max-chars must be at least 1000" >&2
  exit 2
fi
case "${PICKBRAIN_DUMP_WINDOW}" in
  *[!0-9]*|"")
    echo "error: --pickbrain-dump-window must be a non-negative integer" >&2
    exit 2
    ;;
esac
if [[ "${PICKBRAIN_DUMP_WINDOW}" -gt 25 ]]; then
  echo "error: --pickbrain-dump-window must be 25 or lower" >&2
  exit 2
fi

[[ -d "${REPO}" ]] || {
  echo "error: repo does not exist: ${REPO}" >&2
  exit 1
}

REPO_ABS="$(cd "${REPO}" && pwd)"
if [[ -z "${OUT}" ]]; then
  OUT="${REPO_ABS}/reports/retrospect/$(date -u +"%Y%m%d-%H%M%S")"
fi
mkdir -p "${OUT}"
OUT_ABS="$(cd "${OUT}" && pwd)"

mkdir -p "${OUT_ABS}/inputs/pickbrain" "${OUT_ABS}/inputs/git" "${OUT_ABS}/inputs/sessions/raw"
WARNINGS="${OUT_ABS}/inputs/warnings.txt"
: > "${WARNINGS}"

SESSION_CONFIG="${OUT_ABS}/inputs/sessions/config.json"
python3 - "${SESSION_CONFIG}" "${REPO_ABS}" "${INCLUDE_GLOBAL_SESSIONS}" "${HOME:-}" ${SESSION_DIRS[@]+"${SESSION_DIRS[@]}"} <<'PY'
import json
import os
import pathlib
import sys

config_path = pathlib.Path(sys.argv[1])
repo = pathlib.Path(sys.argv[2]).resolve()
include_global = sys.argv[3] == "1"
home = pathlib.Path(sys.argv[4]).expanduser() if sys.argv[4] else None
cli_dirs = sys.argv[5:]
env_dirs = [item for item in os.environ.get("HARNESS_RETROSPECT_SESSION_DIRS", "").split(os.pathsep) if item]

entries = []
for rel in ["sessions", ".sessions", "logs", ".harness/sessions", "reports/sessions"]:
    entries.append({
        "path": str(repo / rel),
        "kind": "repo-local",
        "filter_to_repo": False,
        "source": rel,
    })

for item in cli_dirs:
    path = pathlib.Path(item).expanduser()
    if not path.is_absolute():
        path = (pathlib.Path.cwd() / path).resolve()
    entries.append({
        "path": str(path),
        "kind": "explicit",
        "filter_to_repo": True,
        "source": "--session-dir",
    })

for item in env_dirs:
    path = pathlib.Path(item).expanduser()
    if not path.is_absolute():
        path = (pathlib.Path.cwd() / path).resolve()
    entries.append({
        "path": str(path),
        "kind": "env",
        "filter_to_repo": True,
        "source": "HARNESS_RETROSPECT_SESSION_DIRS",
    })

if include_global and home:
    for rel in [".claude/projects", ".codex/sessions", ".config/claude/projects", "Library/Application Support/Claude/projects"]:
        entries.append({
            "path": str(home / rel),
            "kind": "global",
            "filter_to_repo": True,
            "source": rel,
        })

config_path.write_text(json.dumps({
    "repo": str(repo),
    "include_global_sessions": include_global,
    "entries": entries,
}, indent=2) + "\n", encoding="utf-8")
PY

QUERIES="${OUT_ABS}/inputs/pickbrain/queries.txt"
if [[ -n "${QUERY_FILE}" ]]; then
  [[ -f "${QUERY_FILE}" ]] || {
    echo "error: query file does not exist: ${QUERY_FILE}" >&2
    exit 1
  }
  python3 - "${QUERY_FILE}" "${QUERIES}" <<'PY'
import pathlib
import sys

source, target = map(pathlib.Path, sys.argv[1:3])
queries = []
for line in source.read_text(encoding="utf-8").splitlines():
    item = line.strip()
    if item and not item.startswith("#"):
        queries.append(item)
target.write_text("\n".join(queries) + ("\n" if queries else ""), encoding="utf-8")
PY
else
  repo_name="$(basename "${REPO_ABS}")"
  {
    printf 'project %s what was worked on\n' "${repo_name}"
    printf 'project %s what worked well\n' "${repo_name}"
    printf 'project %s failures regressions blockers\n' "${repo_name}"
    printf 'project %s roadmap backlog next tasks\n' "${repo_name}"
  } > "${QUERIES}"
fi

if git -C "${REPO_ABS}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [[ -n "${SINCE}" ]]; then
    git -C "${REPO_ABS}" log --since="${SINCE}" --pretty=format:'%H%x09%ad%x09%s' --date=iso-strict > "${OUT_ABS}/inputs/git/log.tsv" 2>> "${WARNINGS}" || true
    git -C "${REPO_ABS}" log --since="${SINCE}" --name-only --pretty=format:'commit %H' > "${OUT_ABS}/inputs/git/changed-files.txt" 2>> "${WARNINGS}" || true
  else
    git -C "${REPO_ABS}" log -n 200 --pretty=format:'%H%x09%ad%x09%s' --date=iso-strict > "${OUT_ABS}/inputs/git/log.tsv" 2>> "${WARNINGS}" || true
    git -C "${REPO_ABS}" log -n 200 --name-only --pretty=format:'commit %H' > "${OUT_ABS}/inputs/git/changed-files.txt" 2>> "${WARNINGS}" || true
  fi
  git -C "${REPO_ABS}" status --short > "${OUT_ABS}/inputs/git/status.txt" 2>> "${WARNINGS}" || true
else
  echo "git unavailable or target is not a git repo" >> "${WARNINGS}"
fi

PICKBRAIN_CMD="${HARNESS_RETROSPECT_PICKBRAIN_BIN:-pickbrain}"
PICKBRAIN_RESOLVED=""
if [[ "${PICKBRAIN_CMD}" == */* ]]; then
  if [[ -x "${PICKBRAIN_CMD}" ]]; then
    PICKBRAIN_RESOLVED="${PICKBRAIN_CMD}"
  fi
else
  PICKBRAIN_RESOLVED="$(command -v "${PICKBRAIN_CMD}" || true)"
fi

if [[ -n "${PICKBRAIN_RESOLVED}" ]]; then
  index=0
  while IFS= read -r query; do
    [[ -n "${query}" ]] || continue
    index=$((index + 1))
    prefix="${OUT_ABS}/inputs/pickbrain/query-$(printf '%03d' "${index}")"
    printf '%s\n' "${query}" > "${prefix}.query"
    if [[ -n "${SINCE}" ]]; then
      (cd "${REPO_ABS}" && "${PICKBRAIN_RESOLVED}" --since "${SINCE}" "${query}") > "${prefix}.txt" 2> "${prefix}.err" || {
        echo "pickbrain query failed: ${query}" >> "${WARNINGS}"
      }
    else
      (cd "${REPO_ABS}" && "${PICKBRAIN_RESOLVED}" "${query}") > "${prefix}.txt" 2> "${prefix}.err" || {
        echo "pickbrain query failed: ${query}" >> "${WARNINGS}"
      }
    fi
  done < "${QUERIES}"
else
  echo "pickbrain unavailable: ${PICKBRAIN_CMD}" >> "${WARNINGS}"
fi

if [[ "${PICKBRAIN_DUMP}" -eq 1 ]]; then
  mkdir -p "${OUT_ABS}/inputs/pickbrain/dumps"
  DUMP_REQUESTS="${OUT_ABS}/inputs/pickbrain/dumps/requests.tsv"
  if [[ -n "${PICKBRAIN_RESOLVED}" ]]; then
    python3 - "${OUT_ABS}/inputs/pickbrain" "${PICKBRAIN_DUMP_WINDOW}" > "${DUMP_REQUESTS}" <<'PY'
import pathlib
import re
import sys

pickbrain_dir = pathlib.Path(sys.argv[1])
window = int(sys.argv[2])
seen = set()
session_patterns = [
    re.compile(r"\bSession ID:\s*([A-Za-z0-9_.:-]{6,})", re.I),
    re.compile(r"\bsession[_ -]?id[:=]\s*([A-Za-z0-9_.:-]{6,})", re.I),
    re.compile(r"\bsession[:=]\s*([A-Za-z0-9_.:-]{6,})", re.I),
]
turn_patterns = [
    re.compile(r"\bTurn(?: number)?[:=]\s*#?(\d+)", re.I),
    re.compile(r"\bturn[_ -]?(?:number|index)?[:=]\s*#?(\d+)", re.I),
]

for path in sorted(pickbrain_dir.glob("query-*.txt")):
    current_session = None
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        for pattern in session_patterns:
            match = pattern.search(line)
            if match:
                current_session = match.group(1).strip().strip(",.;")
                break
        turn = None
        for pattern in turn_patterns:
            match = pattern.search(line)
            if match:
                turn = int(match.group(1))
                break
        if current_session and turn is not None:
            start = max(0, turn - window)
            end = turn + window
            key = (current_session, start, end)
            if key not in seen:
                seen.add(key)
                print(f"{len(seen):03d}\t{current_session}\t{turn}\t{start}\t{end}\t{path.name}")
PY
    if [[ -s "${DUMP_REQUESTS}" ]]; then
      while IFS=$'\t' read -r dump_index session_id turn start_turn end_turn query_file; do
        prefix="${OUT_ABS}/inputs/pickbrain/dumps/dump-${dump_index}"
        printf '%s\n' "${session_id}" > "${prefix}.session"
        printf '%s\n' "${start_turn}-${end_turn}" > "${prefix}.turns"
        set +e
        (cd "${REPO_ABS}" && "${PICKBRAIN_RESOLVED}" --dump "${session_id}" --turns "${start_turn}-${end_turn}") > "${prefix}.txt" 2> "${prefix}.err"
        dump_status=$?
        set -e
        python3 - "${prefix}.json" "${session_id}" "${turn}" "${start_turn}" "${end_turn}" "${query_file}" "${dump_status}" <<'PY'
import json
import pathlib
import sys

path, session_id, turn, start, end, query_file, status = sys.argv[1:8]
status = int(status)
pathlib.Path(path).write_text(json.dumps({
    "session_id": session_id,
    "turn": int(turn),
    "turn_range": f"{start}-{end}",
    "query_file": query_file,
    "status": "pass" if status == 0 else "fail",
    "exit_code": status,
    "output_path": pathlib.Path(path).with_suffix(".txt").name,
    "stderr_path": pathlib.Path(path).with_suffix(".err").name,
}, indent=2) + "\n", encoding="utf-8")
PY
        if [[ "${dump_status}" -ne 0 ]]; then
          echo "pickbrain dump failed for session ${session_id} turns ${start_turn}-${end_turn}" >> "${WARNINGS}"
        fi
      done < "${DUMP_REQUESTS}"
    else
      echo "pickbrain dump requested but no session/turn pairs were found in query outputs" >> "${WARNINGS}"
    fi
  else
    echo "pickbrain dump requested but pickbrain is unavailable: ${PICKBRAIN_CMD}" >> "${WARNINGS}"
  fi
fi

if [[ "${SEMANTIC}" -eq 1 ]]; then
  mkdir -p "${OUT_ABS}/inputs/content"
  python3 - "${REPO_ABS}" "${OUT_ABS}" "${CONTENT_MAX_CHARS}" <<'PY'
import json
import pathlib
import re
import sys

repo = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
max_chars = int(sys.argv[3])
content_dir = out / "inputs" / "content"
content_dir.mkdir(parents=True, exist_ok=True)
warnings_path = out / "inputs" / "warnings.txt"

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
    for key in ("session_id", "sessionId", "conversation_id", "conversationId", "turn", "turn_index", "uuid"):
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
            "role": role,
            "text": re.sub(r"\n{3,}", "\n\n", text.strip()),
            "source": source,
            "metadata": meta,
        }
    for key in ("messages", "turns", "events", "entries", "items", "children"):
        child = value.get(key)
        if isinstance(child, (list, dict)):
            yield from walk_messages(child, source, meta)

def is_relative_to(path: pathlib.Path, parent: pathlib.Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except Exception:
        return False

def display_path(path: pathlib.Path) -> str:
    try:
        return str(path.resolve().relative_to(repo.resolve()))
    except Exception:
        return str(path)

def repo_fingerprints():
    repo_text = str(repo)
    repo_resolved = str(repo.resolve())
    return [
        repo_text,
        repo_resolved,
        repo_text.replace("/", "-").strip("-"),
        repo_text.replace("/", "_").strip("_"),
        repo_resolved.replace("/", "-").strip("-"),
        repo_resolved.replace("/", "_").strip("_"),
    ]

def matches_repo(path: pathlib.Path, fingerprints):
    haystack = f"{path}\n{read_text(path)[:60000]}"
    return any(item and item in haystack for item in fingerprints)

def discover_session_files():
    config = load_json(out / "inputs" / "sessions" / "config.json", {"entries": []})
    fingerprints = repo_fingerprints()
    selected = []
    selected_paths = set()
    sources = []
    for entry in config.get("entries", []):
        root = pathlib.Path(entry.get("path", "")).expanduser()
        require_match = bool(entry.get("filter_to_repo")) and not is_relative_to(root, repo)
        record = {
            "path": str(root),
            "kind": entry.get("kind", "unknown"),
            "source": entry.get("source", ""),
            "exists": root.exists(),
            "filter_to_repo": require_match,
            "files_seen": 0,
            "files_selected": 0,
        }
        if root.exists():
            candidates = sorted(set(root.rglob("*.jsonl")) | set(root.rglob("*.json")))
            record["files_seen"] = len(candidates)
            for path in candidates:
                if require_match and not matches_repo(path, fingerprints):
                    continue
                resolved = str(path.resolve())
                if resolved in selected_paths:
                    continue
                selected_paths.add(resolved)
                record["files_selected"] += 1
                selected.append({
                    "path": path,
                    "display": display_path(path),
                    "kind": record["kind"],
                    "root": str(root),
                })
        sources.append(record)
    (out / "inputs" / "sessions" / "sources.json").write_text(json.dumps({
        "repo": str(repo),
        "sources": sources,
        "selected_files": [
            {"path": item["display"], "kind": item["kind"], "root": item["root"]}
            for item in selected[:200]
        ],
    }, indent=2) + "\n", encoding="utf-8")
    return selected[:200], sources

session_entries, session_sources = discover_session_files()

messages = []
seen = set()
for item in session_entries:
    path = item["path"]
    source = item["display"]
    if path.suffix == ".jsonl":
        for line_no, line in enumerate(read_text(path).splitlines(), start=1):
            if not line.strip():
                continue
            try:
                data = json.loads(line)
            except Exception:
                continue
            for message in walk_messages(data, f"{source}:{line_no}"):
                key = (message["role"], message["source"], message["text"])
                if key not in seen:
                    seen.add(key)
                    messages.append(message)
    else:
        data = load_json(path, None)
        if data is not None:
            for message in walk_messages(data, source):
                key = (message["role"], message["source"], message["text"])
                if key not in seen:
                    seen.add(key)
                    messages.append(message)

human_messages = [item for item in messages if item["role"] == "human"]
assistant_messages = [item for item in messages if item["role"] == "assistant"]

def write_jsonl(path, rows):
    with path.open("w", encoding="utf-8") as handle:
        for index, row in enumerate(rows, start=1):
            payload = dict(row)
            payload["id"] = f"{row['role']}-{index:03d}"
            handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")

write_jsonl(content_dir / "human-messages.jsonl", human_messages)
write_jsonl(content_dir / "assistant-messages.jsonl", assistant_messages)

def evidence_lines(rows, prefix, limit):
    lines = []
    used = 0
    for index, row in enumerate(rows, start=1):
        text = row["text"].strip()
        if not text:
            continue
        entry = f"[{prefix}-{index:03d}] source={row['source']} metadata={json.dumps(row['metadata'], sort_keys=True)}\n{text}\n"
        if used + len(entry) > limit:
            break
        used += len(entry)
        lines.append(entry)
    return lines, used

human_budget = max_chars * 70 // 100
assistant_budget = max_chars * 20 // 100
pickbrain_budget = max_chars - human_budget - assistant_budget
human_lines, human_chars = evidence_lines(human_messages, "human", human_budget)
assistant_lines, assistant_chars = evidence_lines(assistant_messages, "assistant", assistant_budget)

pickbrain_lines = []
pickbrain_chars = 0
pickbrain_evidence = list(sorted((out / "inputs" / "pickbrain").glob("query-*.txt")))
pickbrain_evidence.extend(sorted((out / "inputs" / "pickbrain" / "dumps").glob("dump-*.txt")))
for path in pickbrain_evidence:
    text = read_text(path).strip()
    if not text:
        continue
    label = f"pickbrain-dump:{path.name}" if path.parent.name == "dumps" else f"pickbrain:{path.name}"
    entry = f"[{label}]\n{text[:4000]}\n"
    if pickbrain_chars + len(entry) > pickbrain_budget:
        break
    pickbrain_chars += len(entry)
    pickbrain_lines.append(entry)

corpus = "\n".join([
    "# Human Messages",
    *human_lines,
    "# Assistant Messages",
    *assistant_lines,
    "# Pickbrain Results",
    *pickbrain_lines,
]).strip() + "\n"
(content_dir / "session-corpus.txt").write_text(corpus, encoding="utf-8")

prompt = f"""# Semantic Retrospective Prompt

You are analyzing historical coding-session content for this repository.

Use only the evidence below. Focus especially on human/user messages, then
compare them against assistant/agent replies to identify response patterns.
Infer patterns only when they are supported by repeated evidence, and label
weaker claims as inference.

Produce a concise Markdown report with these sections:

## Human Intent And Requests
## Human Priorities And Preferences
## Repeated Pain Or Friction
## Decisions And Follow-through
## Agent Response Patterns
## Workflows That Helped
## Workflows That Failed
## Product Or Process Requirements
## Roadmap Implications
## Backlog Suggestions

For each important claim, cite evidence ids such as [human-001] or
[pickbrain:query-001.txt].

Repository: `{repo}`
Session files scanned: {len(session_entries)}
Human messages extracted: {len(human_messages)}
Assistant messages extracted: {len(assistant_messages)}

{corpus}
"""
(content_dir / "llm-prompt.md").write_text(prompt, encoding="utf-8")

summary = {
    "requested": True,
    "session_files": len(session_entries),
    "session_sources": session_sources,
    "human_messages": len(human_messages),
    "assistant_messages": len(assistant_messages),
    "pickbrain_dump_outputs": len(list((out / "inputs" / "pickbrain" / "dumps").glob("dump-*.txt"))),
    "corpus_chars": len(corpus),
    "prompt_chars": len(prompt),
    "max_chars": max_chars,
    "human_messages_path": "inputs/content/human-messages.jsonl",
    "assistant_messages_path": "inputs/content/assistant-messages.jsonl",
    "corpus_path": "inputs/content/session-corpus.txt",
    "prompt_path": "inputs/content/llm-prompt.md",
}
(content_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

if not human_messages:
    with warnings_path.open("a", encoding="utf-8") as handle:
        handle.write("semantic analysis requested but no human messages were extracted\n")
PY

  LLM_STATUS="${OUT_ABS}/inputs/content/llm-status.json"
  if [[ -n "${LLM_CMD}" ]]; then
    LLM_PROMPT="${OUT_ABS}/inputs/content/llm-prompt.md"
    LLM_OUTPUT="${OUT_ABS}/semantic-analysis.md"
    LLM_ERR="${OUT_ABS}/inputs/content/llm.err"
    STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    set +e
    (cd "${REPO_ABS}" && sh -c "${LLM_CMD}") < "${LLM_PROMPT}" > "${LLM_OUTPUT}" 2> "${LLM_ERR}"
    LLM_EXIT=$?
    set -e
    ENDED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    python3 - "${LLM_STATUS}" "${LLM_CMD}" "${LLM_EXIT}" "${STARTED_AT}" "${ENDED_AT}" "${LLM_OUTPUT}" "${LLM_ERR}" <<'PY'
import json
import pathlib
import sys

status_path, command, exit_code, started_at, ended_at, output_path, err_path = sys.argv[1:8]
exit_code = int(exit_code)
data = {
    "requested": True,
    "status": "pass" if exit_code == 0 else "fail",
    "exit_code": exit_code,
    "command": command,
    "started_at": started_at,
    "ended_at": ended_at,
    "output_path": "semantic-analysis.md",
    "stderr_path": "inputs/content/llm.err",
}
pathlib.Path(status_path).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
    if [[ "${LLM_EXIT}" -ne 0 ]]; then
      echo "semantic LLM command failed with exit ${LLM_EXIT}: ${LLM_CMD}" >> "${WARNINGS}"
    fi
  else
    python3 - "${LLM_STATUS}" <<'PY'
import json
import pathlib
import sys

pathlib.Path(sys.argv[1]).write_text(json.dumps({
    "requested": False,
    "status": "not-requested",
    "exit_code": None,
    "command": None,
}, indent=2) + "\n", encoding="utf-8")
PY
  fi
fi

python3 - "${REPO_ABS}" "${OUT_ABS}" "${SINCE}" <<'PY'
import json
import pathlib
import re
import shutil
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone

repo = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
since = sys.argv[3] or None

def load_json(path: pathlib.Path, fallback=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback

def read_text(path: pathlib.Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""

def section(text: str, heading: str) -> str:
    lines = text.splitlines()
    active = False
    collected = []
    for line in lines:
        if line.strip() == heading:
            active = True
            continue
        if active and line.startswith("## "):
            break
        if active:
            collected.append(line)
    return "\n".join(collected).strip()

def nonempty_lines(text: str):
    return [line.strip() for line in text.splitlines() if line.strip()]

def strings_from_json(value):
    found = []
    if isinstance(value, str):
        found.append(value)
    elif isinstance(value, list):
        for item in value:
            found.extend(strings_from_json(item))
    elif isinstance(value, dict):
        for item in value.values():
            found.extend(strings_from_json(item))
    return found

def is_relative_to(path: pathlib.Path, parent: pathlib.Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False

def parse_timestamp(value):
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)

def parse_since(value):
    if not value:
        return None
    parsed = parse_timestamp(value)
    if parsed:
        return parsed
    text = value.strip().lower()
    now = datetime.now(timezone.utc)
    if text == "today":
        return now.replace(hour=0, minute=0, second=0, microsecond=0)
    if text == "yesterday":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return start - timedelta(days=1)
    relative = re.fullmatch(r"(?:the\s+)?(?:past|last)\s+(\d+)\s+(second|minute|hour|day|week|month|year)s?", text)
    ago = re.fullmatch(r"(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago", text)
    match = relative or ago
    if match:
        amount = int(match.group(1))
        unit = match.group(2)
        multipliers = {
            "second": timedelta(seconds=1),
            "minute": timedelta(minutes=1),
            "hour": timedelta(hours=1),
            "day": timedelta(days=1),
            "week": timedelta(weeks=1),
            "month": timedelta(days=30),
            "year": timedelta(days=365),
        }
        return now - amount * multipliers[unit]
    return None

def run_event_times(run: pathlib.Path, meta: dict, task: dict):
    values = [
        task.get("created_at"),
        task.get("ended_at"),
        meta.get("created_at"),
        meta.get("ended_at"),
    ]
    memory_dir = run / "memory"
    if memory_dir.exists():
        for memory in memory_dir.glob("[0-9][0-9][0-9]-*.md"):
            match = re.search(r"^date:\s*(.+)$", read_text(memory), re.M)
            if match:
                values.append(match.group(1))
    for attempt in run.glob("artifacts/*/attempt-*.json"):
        data = load_json(attempt, {})
        if isinstance(data, dict):
            values.extend([data.get("started_at"), data.get("ended_at")])
    return [stamp for stamp in (parse_timestamp(value) for value in values) if stamp]

def task_in_window(task: dict, cutoff):
    if cutoff is None:
        return True
    task_id = task.get("id", "")
    run_text = task.get("run_dir") or (f"runs/{task_id}" if task_id else "")
    run = repo / run_text
    meta = load_json(run / "meta.json", {}) if run.exists() else {}
    return any(stamp >= cutoff for stamp in run_event_times(run, meta, task))

def spec_in_window(spec: pathlib.Path, cutoff):
    if cutoff is None:
        return True
    text = read_text(spec)
    match = re.search(r"Task completed\s+([^,\n]+)", text)
    if not match:
        return False
    stamp = parse_timestamp(match.group(1))
    return bool(stamp and stamp >= cutoff)

generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
warnings = nonempty_lines(read_text(out / "inputs" / "warnings.txt"))
cutoff = parse_since(since)
if since and cutoff is None:
    message = f"could not parse --since for harness task filtering: {since}"
    warnings.append(message)
    with (out / "inputs" / "warnings.txt").open("a", encoding="utf-8") as handle:
        handle.write(message + "\n")

tasks = []
index_data = load_json(repo / ".harness" / "tasks.json", {"tasks": []})
indexed = index_data.get("tasks", []) if isinstance(index_data, dict) else []
seen = set()
for item in indexed:
    if isinstance(item, dict) and item.get("id"):
        tasks.append(dict(item))
        seen.add(item["id"])

runs_dir = repo / "runs"
if runs_dir.exists():
    for meta_path in sorted(runs_dir.glob("*/meta.json")):
        run = meta_path.parent
        meta = load_json(meta_path, {})
        task_id = meta.get("id") or run.name
        if task_id in seen:
            continue
        eval_data = load_json(run / "eval.json", {})
        tasks.append({
            "id": task_id,
            "mode": meta.get("mode", "unknown"),
            "status": meta.get("status", "unknown"),
            "created_at": meta.get("created_at", ""),
            "run_dir": str(run.relative_to(repo)) if is_relative_to(run, repo) else str(run),
            "eval_status": eval_data.get("status", "missing") if isinstance(eval_data, dict) else "missing",
        })

tasks = [task for task in tasks if task_in_window(task, cutoff)]
selected_task_ids = {task.get("id") for task in tasks if task.get("id")}

mode_counts = Counter(task.get("mode", "unknown") for task in tasks)
status_counts = Counter(task.get("status", "unknown") for task in tasks)
eval_counts = Counter(task.get("eval_status", "unknown") for task in tasks)

attempt_count = 0
failed_attempts = 0
dimension_counts = Counter()
open_items = []
task_descriptions = []
task_log_summaries = []
spec_count = 0

if runs_dir.exists():
    for run in sorted(path for path in runs_dir.iterdir() if path.is_dir()):
        meta = load_json(run / "meta.json", {})
        eval_data = load_json(run / "eval.json", {})
        task_id = meta.get("id") or run.name
        if cutoff is not None and task_id not in selected_task_ids:
            continue
        if meta.get("description"):
            task_descriptions.append(f"{task_id}: {meta['description']}")
        task_log = read_text(run / "task-log.md")
        changed = nonempty_lines(section(task_log, "## What I changed"))
        why = nonempty_lines(section(task_log, "## Why"))
        if changed or why:
            task_log_summaries.append({
                "task_id": task_id,
                "changed": [line.lstrip("- ") for line in changed[:5]],
                "why": [line.lstrip("- ") for line in why[:3]],
            })
        if isinstance(eval_data, dict):
            for dim in (eval_data.get("dimensions") or {}).keys():
                dimension_counts[dim] += 1
        for attempt in run.glob("artifacts/*/attempt-*.json"):
            attempt_count += 1
            data = load_json(attempt, {})
            if data.get("status") == "fail" or data.get("exit_code") not in (None, 0):
                failed_attempts += 1
        memory_files = sorted((run / "memory").glob("[0-9][0-9][0-9]-*.md")) if (run / "memory").exists() else []
        if memory_files:
            final_open = section(read_text(memory_files[-1]), "## Still open")
            for line in nonempty_lines(final_open):
                lowered = line.lower()
                if "no open item" not in lowered and "no open items" not in lowered:
                    open_items.append(f"{task_id}: {line.lstrip('- ')}")

specs_dir = repo / "specs"
if specs_dir.exists():
    specs = [
        spec for spec in sorted(specs_dir.glob("*.md"))
        if cutoff is None or spec.stem in selected_task_ids or spec_in_window(spec, cutoff)
    ]
    spec_count = len(specs)
    for spec in specs:
        text = read_text(spec)
        for line in nonempty_lines(section(text, "## Open items at completion")):
            lowered = line.lower()
            if "no open item" not in lowered and "no entries recorded" not in lowered:
                open_items.append(f"{spec.stem}: {line.lstrip('- ')}")

git_log = out / "inputs" / "git" / "log.tsv"
git_lines = nonempty_lines(read_text(git_log)) if git_log.exists() else []
git_status = nonempty_lines(read_text(out / "inputs" / "git" / "status.txt"))
changed_files = [
    line for line in nonempty_lines(read_text(out / "inputs" / "git" / "changed-files.txt"))
    if not line.startswith("commit ")
]

def repo_fingerprints():
    repo_text = str(repo)
    repo_resolved = str(repo.resolve())
    return [
        repo_text,
        repo_resolved,
        repo_text.replace("/", "-").strip("-"),
        repo_text.replace("/", "_").strip("_"),
        repo_resolved.replace("/", "-").strip("-"),
        repo_resolved.replace("/", "_").strip("_"),
    ]

def matches_repo(path: pathlib.Path, fingerprints):
    haystack = f"{path}\n{read_text(path)[:60000]}"
    return any(item and item in haystack for item in fingerprints)

def display_path(path: pathlib.Path) -> str:
    try:
        return str(path.resolve().relative_to(repo.resolve()))
    except Exception:
        return str(path)

def discover_session_files():
    config = load_json(out / "inputs" / "sessions" / "config.json", {"entries": []})
    fingerprints = repo_fingerprints()
    selected = []
    selected_paths = set()
    sources = []
    for entry in config.get("entries", []):
        root = pathlib.Path(entry.get("path", "")).expanduser()
        require_match = bool(entry.get("filter_to_repo")) and not is_relative_to(root, repo)
        record = {
            "path": str(root),
            "kind": entry.get("kind", "unknown"),
            "source": entry.get("source", ""),
            "exists": root.exists(),
            "filter_to_repo": require_match,
            "files_seen": 0,
            "files_selected": 0,
        }
        if root.exists():
            candidates = sorted(set(root.rglob("*.jsonl")) | set(root.rglob("*.json")))
            record["files_seen"] = len(candidates)
            for path in candidates:
                if require_match and not matches_repo(path, fingerprints):
                    continue
                resolved = str(path.resolve())
                if resolved in selected_paths:
                    continue
                selected_paths.add(resolved)
                record["files_selected"] += 1
                selected.append({
                    "path": path,
                    "display": display_path(path),
                    "kind": record["kind"],
                    "root": str(root),
                })
        sources.append(record)
    (out / "inputs" / "sessions" / "sources.json").write_text(json.dumps({
        "repo": str(repo),
        "sources": sources,
        "selected_files": [
            {"path": item["display"], "kind": item["kind"], "root": item["root"]}
            for item in selected[:200]
        ],
    }, indent=2) + "\n", encoding="utf-8")
    return selected[:200], sources

session_entries, session_sources = discover_session_files()
session_files = [item["path"] for item in session_entries]

session_records = 0
session_text = []
session_tool_mentions = 0
raw_dir = out / "inputs" / "sessions" / "raw"
for idx, path in enumerate(session_files[:200], start=1):
    target = raw_dir / f"{idx:03d}-{path.name}"
    try:
        shutil.copyfile(path, target)
    except Exception:
        pass
    if path.suffix == ".jsonl":
        for line in read_text(path).splitlines():
            if not line.strip():
                continue
            session_records += 1
            try:
                data = json.loads(line)
            except Exception:
                data = line
            if isinstance(data, dict) and any("tool" in str(key).lower() for key in data.keys()):
                session_tool_mentions += 1
            session_text.extend(strings_from_json(data))
    else:
        data = load_json(path, None)
        if data is not None:
            session_records += 1
            session_text.extend(strings_from_json(data))

combined_session_text = "\n".join(session_text).lower()
session_times = sorted(set(re.findall(r"\b\d{4}-\d{2}-\d{2}(?:[tT ][0-9:.+-]+Z?)?", "\n".join(session_text))))
session_metrics = {
    "files": len(session_files),
    "records": session_records,
    "sources": {
        "configured": len(session_sources),
        "selected": len(session_files),
        "by_kind": dict(sorted(Counter(item.get("kind", "unknown") for item in session_entries).items())),
    },
    "time_span": {
        "start": session_times[0] if session_times else None,
        "end": session_times[-1] if session_times else None,
    },
    "tool_mentions": session_tool_mentions,
    "error_mentions": sum(combined_session_text.count(term) for term in ["error", "failed", "failure", "exception", "blocked"]),
    "test_mentions": sum(combined_session_text.count(term) for term in ["test", "pytest", "unit", "verify"]),
    "command_mentions": len(re.findall(r"\b(\./|bash|python3|pytest|npm|git|make)\b", combined_session_text)),
    "file_path_mentions": len(re.findall(r"[\w./-]+\.(py|sh|js|ts|md|json|jsonl)", combined_session_text)),
}
(out / "inputs" / "sessions" / "summary.json").write_text(json.dumps(session_metrics, indent=2) + "\n", encoding="utf-8")

pickbrain_dir = out / "inputs" / "pickbrain"
pickbrain_outputs = sorted(pickbrain_dir.glob("query-*.txt"))
pickbrain_dump_outputs = sorted((pickbrain_dir / "dumps").glob("dump-*.txt"))
pickbrain_available = bool(pickbrain_outputs)
pickbrain_excerpt = []
for path in pickbrain_outputs:
    lines = nonempty_lines(read_text(path))
    if lines:
        pickbrain_excerpt.append({"file": str(path.relative_to(out)), "excerpt": lines[0][:240]})

content_summary = load_json(out / "inputs" / "content" / "summary.json", {
    "requested": False,
    "session_files": 0,
    "human_messages": 0,
    "assistant_messages": 0,
    "corpus_chars": 0,
    "prompt_chars": 0,
    "session_sources": [],
    "pickbrain_dump_outputs": 0,
})
llm_status = load_json(out / "inputs" / "content" / "llm-status.json", {
    "requested": False,
    "status": "not-requested",
    "exit_code": None,
    "command": None,
})
semantic_text = read_text(out / "semantic-analysis.md")
semantic_available = llm_status.get("status") == "pass" and bool(semantic_text.strip())

coverage = {
    "harness_tasks": bool(tasks),
    "specs": spec_count > 0,
    "git": bool(git_lines),
    "pickbrain": pickbrain_available,
    "sessions": bool(session_files),
    "semantic_content": bool(content_summary.get("human_messages")),
    "semantic_llm": semantic_available,
}

metrics = {
    "schema_version": 1,
    "generated_at": generated_at,
    "repo": str(repo),
    "since": since,
    "since_cutoff": cutoff.strftime("%Y-%m-%dT%H:%M:%SZ") if cutoff else None,
    "coverage": coverage,
    "tasks": {
        "total": len(tasks),
        "by_mode": dict(sorted(mode_counts.items())),
        "by_status": dict(sorted(status_counts.items())),
        "by_eval": dict(sorted(eval_counts.items())),
        "descriptions": task_descriptions[:20],
        "task_log_summaries": task_log_summaries[:20],
    },
    "evidence": {
        "attempts": attempt_count,
        "failed_attempts": failed_attempts,
        "dimensions": dict(sorted(dimension_counts.items())),
    },
    "open_items": open_items[:50],
    "specs": {"count": spec_count},
    "git": {
        "available": bool(git_lines),
        "commits": len(git_lines),
        "dirty_entries": len(git_status),
        "changed_file_mentions": len(changed_files),
    },
    "sessions": session_metrics,
    "pickbrain": {
        "available": pickbrain_available,
        "queries": len(nonempty_lines(read_text(pickbrain_dir / "queries.txt"))),
        "outputs": len(pickbrain_outputs),
        "dump_outputs": len(pickbrain_dump_outputs),
        "excerpts": pickbrain_excerpt[:10],
    },
    "content": content_summary,
    "llm": llm_status,
    "warnings": warnings,
}

backlog = []
def add_backlog(task_id, title, priority, mode, rationale, signals, verification):
    backlog.append({
        "id": task_id,
        "title": title,
        "priority": priority,
        "mode": mode,
        "rationale": rationale,
        "source_signals": signals,
        "suggested_verification": verification,
    })

if failed_attempts:
    add_backlog(
        "retro-regression-harvest",
        "Turn failed verification attempts into regression checks",
        "high",
        "planned",
        f"{failed_attempts} failed verification attempt(s) were found in harness artifacts.",
        ["evidence.failed_attempts"],
        "Add or update automated tests, then run them through harness verify.",
    )
if open_items:
    add_backlog(
        "retro-open-items",
        "Resolve recurring retrospective open items",
        "high" if len(open_items) > 3 else "medium",
        "planned",
        f"{len(open_items)} open item signal(s) were found in memory/spec artifacts.",
        ["open_items"],
        "Close or convert each open item into a tracked harness task.",
    )
if not pickbrain_available:
    add_backlog(
        "retro-pickbrain-coverage",
        "Enable Pickbrain coverage for richer session retrospectives",
        "medium",
        "investigation",
        "Pickbrain was unavailable or produced no captured outputs.",
        ["coverage.pickbrain"],
        "Run retrospect with Pickbrain available and confirm inputs/pickbrain contains query outputs.",
    )
if not session_files:
    add_backlog(
        "retro-session-jsonl-coverage",
        "Add a repo-local session JSONL export path",
        "medium",
        "planned",
        "No parseable session JSON/JSONL files were found in the known local locations.",
        ["coverage.sessions"],
        "Place a sample JSONL under sessions/ and rerun harness retrospect.",
    )
if dimension_counts and set(dimension_counts) <= {"unit"}:
    add_backlog(
        "retro-evidence-depth",
        "Broaden evidence beyond unit verification where needed",
        "medium",
        "planned",
        "Only unit evidence dimensions were observed in completed harness tasks.",
        ["evidence.dimensions"],
        "Add live, integration, human, or cross-platform dimensions for tasks that need them.",
    )
if content_summary.get("requested") and content_summary.get("human_messages", 0) and not semantic_available:
    add_backlog(
        "retro-run-semantic-llm",
        "Run LLM synthesis over extracted human session messages",
        "high",
        "planned",
        f"{content_summary.get('human_messages', 0)} human message(s) were extracted but no successful semantic LLM report was captured.",
        ["content.human_messages", "llm.status"],
        "Run harness retrospect with --semantic --llm-cmd and inspect semantic-analysis.md.",
    )
add_backlog(
    "retro-roadmap-review",
    "Review generated roadmap and choose the next harness task",
    "low",
    "planned",
    "The retrospective generated deterministic roadmap and backlog artifacts.",
    ["roadmap.md", "backlog.json"],
    "Create the next harness task from one accepted backlog item.",
)

(out / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
(out / "backlog.json").write_text(json.dumps({
    "schema_version": 1,
    "generated_at": generated_at,
    "repo": str(repo),
    "items": backlog,
}, indent=2) + "\n", encoding="utf-8")

def bullets(items, empty):
    if not items:
        return f"- {empty}"
    return "\n".join(f"- {item}" for item in items)

worked_on = []
if task_descriptions:
    worked_on.extend(task_descriptions[:10])
if task_log_summaries:
    for item in task_log_summaries[:10]:
        for changed in item["changed"][:2]:
            worked_on.append(f"{item['task_id']}: {changed}")
if not worked_on:
    worked_on.extend(task.get("id", "unknown-task") for task in tasks[:10])

what_worked = [
    f"{status_counts.get('done', 0)} completed task(s) are indexed.",
    f"{eval_counts.get('pass', 0)} task(s) have passing eval status.",
]
if pickbrain_available:
    what_worked.append(f"{len(pickbrain_outputs)} Pickbrain query output(s) were captured.")
if session_files:
    what_worked.append(f"{len(session_files)} session file(s) were parsed.")
if content_summary.get("requested"):
    what_worked.append(f"{content_summary.get('human_messages', 0)} human message(s) and {content_summary.get('assistant_messages', 0)} assistant message(s) were extracted for semantic analysis.")
if semantic_available:
    what_worked.append("A semantic LLM analysis was captured in semantic-analysis.md.")

what_failed = []
if failed_attempts:
    what_failed.append(f"{failed_attempts} failed verification attempt(s) were found.")
if open_items:
    what_failed.append(f"{len(open_items)} open item signal(s) remain.")
if warnings:
    what_failed.extend(warnings[:5])
if not what_failed:
    what_failed.append("No explicit failure signals were found in the available deterministic inputs.")

semantic_section = "- Semantic mode was not requested."
if content_summary.get("requested"):
    semantic_section = "\n".join([
        f"- Human messages extracted: {content_summary.get('human_messages', 0)}",
        f"- Assistant messages extracted: {content_summary.get('assistant_messages', 0)}",
        f"- Prompt artifact: {content_summary.get('prompt_path', 'inputs/content/llm-prompt.md')}",
        f"- LLM synthesis status: {llm_status.get('status', 'unknown')}",
        "- LLM synthesis report: semantic-analysis.md" if semantic_available else "- LLM synthesis report: unavailable",
    ])
    if semantic_available:
        excerpt = "\n".join(semantic_text.strip().splitlines()[:20])
        semantic_section = f"{semantic_section}\n\n### LLM Excerpt\n\n{excerpt}"

analysis = f"""# Retrospective Analysis

Generated: {generated_at}
Repo: `{repo}`

## Executive summary

- Tasks indexed: {len(tasks)}
- Completed tasks: {status_counts.get('done', 0)}
- Passing evals: {eval_counts.get('pass', 0)}
- Failed verification attempts: {failed_attempts}
- Session files parsed: {len(session_files)}
- Pickbrain outputs captured: {len(pickbrain_outputs)}
- Human messages extracted: {content_summary.get('human_messages', 0)}
- Semantic LLM status: {llm_status.get('status', 'not-requested')}

## What was worked on

{bullets(worked_on, "No task descriptions or task ids were available.")}

## What worked

{bullets(what_worked, "No positive signals were available.")}

## What did not work

{bullets(what_failed, "No failure signals were available.")}

## Repeated friction and regressions

{bullets(open_items[:20], "No recurring open items were found.")}

## Evidence coverage gaps

- Observed evidence dimensions: {", ".join(sorted(dimension_counts)) if dimension_counts else "none"}
- Git coverage: {"available" if coverage["git"] else "unavailable"}
- Pickbrain coverage: {"available" if coverage["pickbrain"] else "unavailable"}
- Session JSON/JSONL coverage: {"available" if coverage["sessions"] else "unavailable"}
- Semantic content coverage: {"available" if coverage["semantic_content"] else "unavailable"}
- Semantic LLM coverage: {"available" if coverage["semantic_llm"] else "unavailable"}

## Semantic content analysis

{semantic_section}

## Confidence/coverage notes

{bullets(warnings, "No warnings were recorded.")}
"""
(out / "analysis.md").write_text(analysis, encoding="utf-8")

near = [item for item in backlog if item["priority"] == "high"]
mid = [item for item in backlog if item["priority"] == "medium"]
later = [item for item in backlog if item["priority"] == "low"]
roadmap = f"""# Retrospective Roadmap

Generated: {generated_at}

## Near

{bullets([f"{item['id']}: {item['title']}" for item in near], "No high-priority items generated.")}

## Mid

{bullets([f"{item['id']}: {item['title']}" for item in mid], "No medium-priority items generated.")}

## Later

{bullets([f"{item['id']}: {item['title']}" for item in later], "No low-priority items generated.")}
"""
(out / "roadmap.md").write_text(roadmap, encoding="utf-8")
PY

echo "${OUT_ABS}"
