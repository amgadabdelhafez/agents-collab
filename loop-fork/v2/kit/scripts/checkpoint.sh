#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: checkpoint.sh <id> "<topic>"
USAGE
  exit 2
}

[[ $# -ge 2 ]] || usage

TASK_ID="$1"
shift
TOPIC="$*"
RUN_DIR="runs/${TASK_ID}"
MEMORY_DIR="${RUN_DIR}/memory"
LOCK_ROOT=".harness/locks"
LOCK_DIR="${LOCK_ROOT}/checkpoint-${TASK_ID}.lock"

if [[ ! -d "${RUN_DIR}" ]]; then
  echo "error: run does not exist: ${RUN_DIR}" >&2
  exit 1
fi

mkdir -p "${LOCK_ROOT}"
if mkdir "${LOCK_DIR}" 2>/dev/null; then
  {
    printf 'pid=%s\n' "$$"
    printf 'created_at=%s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    printf 'command=checkpoint\n'
  } > "${LOCK_DIR}/owner"
else
  echo "error: lock exists: ${LOCK_DIR} (remove if stale)" >&2
  exit 1
fi

cleanup_lock() {
  rm -rf "${LOCK_DIR}"
}
trap cleanup_lock EXIT INT TERM

mkdir -p "${MEMORY_DIR}"
NOW="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

python3 - "${MEMORY_DIR}" "${TOPIC}" "${NOW}" <<'PY'
import pathlib
import re
import sys

memory_dir = pathlib.Path(sys.argv[1])
topic = sys.argv[2]
now = sys.argv[3]

seqs = []
for path in memory_dir.glob("*.md"):
    match = re.match(r"^(\d{3})-", path.name)
    if match:
        seqs.append(int(match.group(1)))
seq = max(seqs, default=0) + 1
seq_str = f"{seq:03d}"

slug = re.sub(r"[^a-z0-9]+", "-", topic.lower()).strip("-")
slug = slug[:40].strip("-") or "checkpoint"

candidate = memory_dir / f"{seq_str}-{slug}.md"
suffix = 1
while candidate.exists():
    candidate = memory_dir / f"{seq_str}-{slug}-{suffix}.md"
    suffix += 1

content = f"""---
seq: {seq_str}
date: {now}
trigger: manual
topic: {topic}
---

## Decided

## Still open

## Where we are
"""

with candidate.open("x", encoding="utf-8") as f:
    f.write(content)

print(candidate)
PY
