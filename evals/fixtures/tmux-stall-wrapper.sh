#!/usr/bin/env bash
set -euo pipefail

if [[ -f "${LOOP_SMOKE_STALL_MARKER:?}" ]]; then
  sleep 10
  exit 124
fi

exec "${LOOP_SMOKE_REAL_TMUX:?}" "$@"
