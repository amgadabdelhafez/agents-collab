#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: park-idea.sh "<idea>" [--name <slug>] [--from-task <task-id>]
USAGE
  exit 2
}

[[ $# -ge 1 ]] || usage

IDEA="$1"
shift
NAME=""
FROM_TASK=""
CURRENT=".harness/current-task"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      [[ $# -ge 2 ]] || usage
      NAME="$2"
      shift 2
      ;;
    --from-task)
      [[ $# -ge 2 ]] || usage
      FROM_TASK="$2"
      shift 2
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage
      ;;
  esac
done

if [[ -z "${FROM_TASK}" ]] && [[ -f "${CURRENT}" ]]; then
  FROM_TASK="$(cat "${CURRENT}")"
fi

CREATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
mkdir -p "specs" ".harness"

python3 - "${IDEA}" "${NAME}" "${FROM_TASK}" "${CREATED_AT}" <<'PY'
import json
import pathlib
import re
import sys

idea, name, from_task, created_at = sys.argv[1:5]

def slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = value.strip("-")
    value = re.sub(r"-+", "-", value)
    value = value[:64].strip("-")
    if not value or not re.match(r"^[a-z]", value):
        value = f"idea-{value}" if value else "idea"
    return value

idea = idea.strip()
if not idea:
    raise SystemExit("error: idea text is empty")

slug = name.strip() if name.strip() else slugify(idea)
if not re.match(r"^[a-z][a-z0-9-]*$", slug):
    raise SystemExit(f"error: idea name must be kebab-case: {slug}")

spec = pathlib.Path("specs") / f"{slug}.md"
if spec.exists():
    raise SystemExit(f"error: parked idea already exists: {spec}")

source_task = from_task.strip() or "none"
spec.write_text(f"""---
kind: parked-idea
id: {slug}
status: parked
created_at: {created_at}
source_task: {source_task}
---

# {slug}

Idea captured {created_at}.

## Capture

{idea}

## Source

- Active task: {source_task}

## Promotion

Run:

```bash
./harness promote {slug}
```
""", encoding="utf-8")

index = pathlib.Path(".harness") / "parked-ideas.jsonl"
with index.open("a", encoding="utf-8") as f:
    f.write(json.dumps({
        "id": slug,
        "status": "parked",
        "created_at": created_at,
        "source_task": source_task,
        "spec_path": str(spec),
        "capture": idea,
    }) + "\n")

print(f"Parked: {spec}")
PY
