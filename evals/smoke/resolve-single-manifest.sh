#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: resolve-single-manifest.sh <case-home> <repo-id>" >&2
  exit 2
fi

case_home="$1"
repo_id="$2"
repo_runs="${case_home}/.loop/runs/${repo_id}"
manifests=()

if [ -d "${repo_runs}" ]; then
  while IFS= read -r manifest; do
    manifests+=("${manifest}")
  done < <(
    find "${repo_runs}" \
      -mindepth 2 \
      -maxdepth 2 \
      -type f \
      -name manifest.json \
      -print | sort
  )
fi

if [ "${#manifests[@]}" -ne 1 ]; then
  echo "manifest discovery failed: expected exactly one producer manifest under ${repo_runs}, found ${#manifests[@]}" >&2
  exit 1
fi

printf '%s\n' "${manifests[0]}"
