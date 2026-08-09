#!/bin/sh
set -eu

case "${LOOP_SMOKE_EXPECTED_TMUX_SOCKET:-}" in
  /*) ;;
  *) exit 64 ;;
esac
case "${LOOP_SMOKE_REAL_TMUX:-}" in
  /*) ;;
  *) exit 64 ;;
esac
case "${LOOP_SMOKE_TMUX_TRACE:-}" in
  /*) ;;
  *) exit 64 ;;
esac

if [ "$#" -eq 1 ] && [ "${1:-}" = "-V" ]; then
  printf '%s\t%s\n' "$$" '-V' >>"${LOOP_SMOKE_TMUX_TRACE}"
  exec "${LOOP_SMOKE_REAL_TMUX}" -V
fi
if [ "${1:-}" != "-S" ] || \
  [ "${2:-}" != "${LOOP_SMOKE_EXPECTED_TMUX_SOCKET}" ]; then
  printf '%s\tREJECT' "$$" >>"${LOOP_SMOKE_TMUX_TRACE}"
  printf '\t%s' "$@" >>"${LOOP_SMOKE_TMUX_TRACE}"
  printf '\n' >>"${LOOP_SMOKE_TMUX_TRACE}"
  exit 64
fi
printf '%s' "$$" >>"${LOOP_SMOKE_TMUX_TRACE}"
printf '\t%s' "$@" >>"${LOOP_SMOKE_TMUX_TRACE}"
printf '\n' >>"${LOOP_SMOKE_TMUX_TRACE}"
exec "${LOOP_SMOKE_REAL_TMUX}" "$@"
