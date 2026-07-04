#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: resume.sh <id>
USAGE
  exit 2
}

[[ $# -eq 1 ]] || usage

TASK_ID="$1"
MEMORY_DIR="runs/${TASK_ID}/memory"

if [[ ! -d "${MEMORY_DIR}" ]]; then
  echo "error: memory directory does not exist: ${MEMORY_DIR}" >&2
  exit 1
fi

shopt -s nullglob
files=("${MEMORY_DIR}"/[0-9][0-9][0-9]-*.md)

if [[ ${#files[@]} -eq 0 ]]; then
  echo "error: no memory files found in ${MEMORY_DIR}" >&2
  exit 1
fi

for file in "${files[@]}"; do
  printf '===== FILE: %s =====\n' "${file}"
  cat "${file}"
  printf '\n'
done
