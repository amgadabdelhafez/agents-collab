#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage:
  tracker.sh status
  tracker.sh create --title <title> [--body <text>] [--artifact <path>] [--task <task-id>] [--label <label>...]
  tracker.sh comment <issue-id> --body <text> [--task <task-id>]
  tracker.sh link --artifact <path> --url <url> [--task <task-id>] [--issue <issue-id>]
USAGE
  exit 2
}

[[ $# -ge 1 ]] || usage

COMMAND="$1"
shift
CONFIG=".harness/tracker.json"

python_tracker() {
  python3 - "$@"
}

case "${COMMAND}" in
  status)
    [[ $# -eq 0 ]] || usage
    python_tracker "${CONFIG}" status <<'PY'
import json
import pathlib
import sys

config_path = pathlib.Path(sys.argv[1])
config = {"provider": "none"}
if config_path.exists():
    config.update(json.loads(config_path.read_text(encoding="utf-8")))
print(json.dumps({
    "provider": config.get("provider", "none"),
    "config": str(config_path),
    "enabled": config.get("provider", "none") != "none",
}, indent=2))
PY
    ;;
  create)
    TITLE=""
    BODY=""
    ARTIFACT=""
    TASK_ID=""
    LABELS=()
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --title)
          [[ $# -ge 2 ]] || usage
          TITLE="$2"
          shift 2
          ;;
        --body)
          [[ $# -ge 2 ]] || usage
          BODY="$2"
          shift 2
          ;;
        --artifact)
          [[ $# -ge 2 ]] || usage
          ARTIFACT="$2"
          shift 2
          ;;
        --task)
          [[ $# -ge 2 ]] || usage
          TASK_ID="$2"
          shift 2
          ;;
        --label)
          [[ $# -ge 2 ]] || usage
          LABELS+=("$2")
          shift 2
          ;;
        *)
          echo "error: unknown argument: $1" >&2
          usage
          ;;
      esac
    done
    [[ -n "${TITLE}" ]] || {
      echo "error: create requires --title" >&2
      exit 2
    }
    tracker_args=("${CONFIG}" create "${TITLE}" "${BODY}" "${ARTIFACT}" "${TASK_ID}")
    if [[ "${#LABELS[@]}" -gt 0 ]]; then
      tracker_args+=("${LABELS[@]}")
    fi
    python_tracker "${tracker_args[@]}" <<'PY'
import json
import pathlib
import sys
from datetime import datetime, timezone

config_path, command, title, body, artifact, task_id, *labels = sys.argv[1:]
config = {"provider": "none"}
path = pathlib.Path(config_path)
if path.exists():
    config.update(json.loads(path.read_text(encoding="utf-8")))
provider = config.get("provider", "none")
ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
if provider == "none":
    print(json.dumps({"status": "skipped", "provider": provider, "reason": "tracker disabled"}))
    raise SystemExit(0)

issues_path = pathlib.Path(config.get("issues_path", ".harness/tracker-issues.jsonl"))
links_path = pathlib.Path(config.get("links_path", ".harness/artifact-links.jsonl"))
issues_path.parent.mkdir(parents=True, exist_ok=True)
links_path.parent.mkdir(parents=True, exist_ok=True)
existing = [line for line in issues_path.read_text(encoding="utf-8").splitlines()] if issues_path.exists() else []
prefix = config.get("id_prefix", provider.upper())
issue_id = f"{prefix}-{len(existing) + 1}"
url_prefix = config.get("url_prefix", "")
url = f"{url_prefix.rstrip('/')}/{issue_id}" if url_prefix else None
row = {
    "ts": ts,
    "id": issue_id,
    "provider": provider,
    "title": title,
    "body": body,
    "task": task_id or None,
    "labels": labels,
    "url": url,
}
with issues_path.open("a", encoding="utf-8") as f:
    f.write(json.dumps(row) + "\n")
if artifact and url:
    with links_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps({
            "ts": ts,
            "task": task_id or None,
            "artifact": artifact,
            "issue": issue_id,
            "url": url,
        }) + "\n")
print(json.dumps({"status": "created", "provider": provider, "id": issue_id, "url": url, "path": str(issues_path)}))
PY
    ;;
  comment)
    [[ $# -ge 1 ]] || usage
    ISSUE_ID="$1"
    shift
    BODY=""
    TASK_ID=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --body)
          [[ $# -ge 2 ]] || usage
          BODY="$2"
          shift 2
          ;;
        --task)
          [[ $# -ge 2 ]] || usage
          TASK_ID="$2"
          shift 2
          ;;
        *)
          echo "error: unknown argument: $1" >&2
          usage
          ;;
      esac
    done
    [[ -n "${BODY}" ]] || {
      echo "error: comment requires --body" >&2
      exit 2
    }
    python_tracker "${CONFIG}" comment "${ISSUE_ID}" "${BODY}" "${TASK_ID}" <<'PY'
import json
import pathlib
import sys
from datetime import datetime, timezone

config_path, command, issue_id, body, task_id = sys.argv[1:]
config = {"provider": "none"}
path = pathlib.Path(config_path)
if path.exists():
    config.update(json.loads(path.read_text(encoding="utf-8")))
provider = config.get("provider", "none")
if provider == "none":
    print(json.dumps({"status": "skipped", "provider": provider, "reason": "tracker disabled"}))
    raise SystemExit(0)
comments_path = pathlib.Path(config.get("comments_path", ".harness/tracker-comments.jsonl"))
comments_path.parent.mkdir(parents=True, exist_ok=True)
row = {
    "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "provider": provider,
    "issue": issue_id,
    "task": task_id or None,
    "body": body,
}
with comments_path.open("a", encoding="utf-8") as f:
    f.write(json.dumps(row) + "\n")
print(json.dumps({"status": "commented", "provider": provider, "issue": issue_id, "path": str(comments_path)}))
PY
    ;;
  link)
    ARTIFACT=""
    URL=""
    TASK_ID=""
    ISSUE_ID=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --artifact)
          [[ $# -ge 2 ]] || usage
          ARTIFACT="$2"
          shift 2
          ;;
        --url)
          [[ $# -ge 2 ]] || usage
          URL="$2"
          shift 2
          ;;
        --task)
          [[ $# -ge 2 ]] || usage
          TASK_ID="$2"
          shift 2
          ;;
        --issue)
          [[ $# -ge 2 ]] || usage
          ISSUE_ID="$2"
          shift 2
          ;;
        *)
          echo "error: unknown argument: $1" >&2
          usage
          ;;
      esac
    done
    [[ -n "${ARTIFACT}" && -n "${URL}" ]] || {
      echo "error: link requires --artifact and --url" >&2
      exit 2
    }
    python_tracker "${CONFIG}" link "${ARTIFACT}" "${URL}" "${TASK_ID}" "${ISSUE_ID}" <<'PY'
import json
import pathlib
import sys
from datetime import datetime, timezone

config_path, command, artifact, url, task_id, issue_id = sys.argv[1:]
config = {"provider": "none"}
path = pathlib.Path(config_path)
if path.exists():
    config.update(json.loads(path.read_text(encoding="utf-8")))
links_path = pathlib.Path(config.get("links_path", ".harness/artifact-links.jsonl"))
links_path.parent.mkdir(parents=True, exist_ok=True)
row = {
    "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "provider": config.get("provider", "none"),
    "task": task_id or None,
    "artifact": artifact,
    "issue": issue_id or None,
    "url": url,
}
with links_path.open("a", encoding="utf-8") as f:
    f.write(json.dumps(row) + "\n")
print(json.dumps({"status": "linked", "path": str(links_path), "url": url}))
PY
    ;;
  *)
    echo "error: unknown command: ${COMMAND}" >&2
    usage
    ;;
esac
