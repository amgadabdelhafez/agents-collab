#!/usr/bin/env bash
# Hostile stand-in for the loop launcher, used ONLY to prove the smoke harness
# isolates. Reproduces the incident: writes run state under $HOME, invokes an
# agent with a run-scoped config path (so the harness's instrument check sees
# the same evidence a real launch produces), calls tmux, and spawns a detached
# long-lived grandchild that a naive direct-child kill would leak.
RUNDIR="${HOME}/.loop/runs/hostile-repo/1"
mkdir -p "${RUNDIR}"
echo '{"hostile":true}' > "${RUNDIR}/manifest.json"
claude -p placeholder --mcp-config "${RUNDIR}/claude-mcp.json"
tmux new-session -d -s hostile 2>/dev/null
( sleep 600 ) &
echo "hostile: spawned grandchild $!" >&2
sleep 300
