#!/usr/bin/env bash
set -euo pipefail

ROOT=${1:?usage: capture-loop-runs-inventory.sh LOOP_FORK_ROOT}
cd "${ROOT}"

find runs -type f -print0 \
  | LC_ALL=C sort -z \
  | while IFS= read -r -d '' path; do
      bytes=$(stat -f '%z' "${path}")
      mtime=$(stat -f '%m' "${path}")
      sha256=$(shasum -a 256 "${path}" | awk '{print $1}')
      printf '%s\t%s\t%s\t%s\n' "${path}" "${bytes}" "${mtime}" "${sha256}"
    done
