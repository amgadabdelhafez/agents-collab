#!/bin/sh
# Runs "$@" (a `bun test` of one file) in an environment that cannot reach the
# operator's live state: a fresh scratch HOME (so the default storage root,
# `$HOME/.loop/runs`, and `os.homedir()` hold nothing live) and a fresh scratch
# TMUX_TMPDIR with TMUX, TMUX_PANE and LOOP_TMUX_SOCKET unset (so a plain
# `tmux` reaches no live server). It must be the launch environment: Bun fixes
# `os.homedir()` and the environment `Bun.spawn` passes to children at
# startup, so a preload that edits `process.env` reaches neither.
# `tests/setup.ts` refuses to run without it.
base=${TMPDIR:-/tmp}
scratch=$(mktemp -d "${base%/}/loop-test-env.XXXXXX") || exit 1
mkdir -p "$scratch/home" "$scratch/tmux" || exit 1
unset TMUX TMUX_PANE LOOP_TMUX_SOCKET
HOME="$scratch/home" TMUX_TMPDIR="$scratch/tmux" LOOP_TEST_HERMETIC_ENV="$scratch" "$@"
status=$?
rm -rf "$scratch"
exit "$status"
