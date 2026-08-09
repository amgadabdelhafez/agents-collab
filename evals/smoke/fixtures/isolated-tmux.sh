#!/bin/sh
set -eu

: "${LOOP_SMOKE_REAL_TMUX:?LOOP_SMOKE_REAL_TMUX is required}"
: "${LOOP_TMUX_SOCKET:?LOOP_TMUX_SOCKET is required}"

case "${LOOP_TMUX_SOCKET}" in
  /*) ;;
  *)
    echo "isolated tmux fixture: LOOP_TMUX_SOCKET must be absolute" >&2
    exit 2
    ;;
esac

if [ "${1:-}" = "-V" ] && [ "$#" -eq 1 ]; then
  exec "${LOOP_SMOKE_REAL_TMUX}" "$@"
fi
if [ "${1:-}" != "-S" ] || [ "${2:-}" != "${LOOP_TMUX_SOCKET}" ]; then
  echo "isolated tmux fixture: product argv did not use exact LOOP_TMUX_SOCKET" >&2
  exit 2
fi

exec "${LOOP_SMOKE_REAL_TMUX}" "$@"
