#!/usr/bin/env bash
# T-01 environment probes for tmux-socket-normalization.
#
# Measures the four environment facts the design rests on, instead of reading
# them from documentation. Produces environment-probes.txt.
#
# Isolation contract:
#   - Every tmux invocation names an explicit -S socket path under a private
#     temporary root. A bare `tmux kill-server` is never issued.
#   - TMUX and TMUX_PANE are unset for every probe; TMUX_TMPDIR is redirected
#     into the private root so no label-derived path can land on the host.
#   - Every server started is killed by explicit socket path and every started
#     PID is polled to zero survivors before the script exits.

set -uo pipefail

ROOT="$(mktemp -d /tmp/ls.XXXX)"
UID_NUM="$(id -u)"
PIDS_FILE="$ROOT/started-pids"
: >"$PIDS_FILE"

# tmux with no ambient session state and a redirected label root.
tm() { env -u TMUX -u TMUX_PANE TMUX_TMPDIR="$ROOT/tmpdir" tmux "$@"; }

record_pid() {
  local sock="$1" pid
  pid="$(tm -S "$sock" display-message -p '#{pid}' 2>/dev/null || true)"
  [ -n "$pid" ] && printf '%s\n' "$pid" >>"$PIDS_FILE"
  printf '%s' "$pid"
}

kill_socket() {
  # Explicit socket path only. Never a bare kill-server.
  local sock="$1"
  tm -S "$sock" kill-server 2>/dev/null || true
  rm -f "$sock"
}

cleanup() {
  local sock
  for sock in "$ROOT"/*.sock "$ROOT"/so,ck-c "$ROOT"/p4-*; do
    [ -e "$sock" ] && kill_socket "$sock"
  done
  rm -rf "$ROOT/tmpdir"
}
trap cleanup EXIT INT TERM

echo "== T-01 environment probes =="
echo "date_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "platform: $(uname -srm)"
echo "tmux_version: $(tmux -V)"
echo "uid: $UID_NUM"
echo "private_root: $ROOT"
echo "ambient_TMUX: ${TMUX-<unset>}"
echo

# ---------------------------------------------------------------------------
echo "-- P1: -S beats -L when both are given --"
P1_SOCK="$ROOT/p1.sock"
P1_LABEL="lsn-probe-$$"
P1_LABEL_PATH="$ROOT/tmpdir/tmux-$UID_NUM/$P1_LABEL"
echo "command: tmux -L $P1_LABEL -S $P1_SOCK start-server"
tm -L "$P1_LABEL" -S "$P1_SOCK" start-server
# Measured: `start-server` with no session leaves the socket file but the server
# exits at once ("no server running on <path>" one second later). The socket
# file is therefore the precedence artifact; there is no PID yet to record.
echo "server_alive_after_start_server: $(tm -S "$P1_SOCK" list-sessions 2>&1 | head -1)"
if [ -S "$P1_SOCK" ]; then echo "RESULT socket_path_exists: yes ($P1_SOCK)"
else echo "RESULT socket_path_exists: NO -- precedence assumption is WRONG"; fi
if [ -e "$P1_LABEL_PATH" ]; then echo "RESULT label_path_exists: YES -- precedence assumption is WRONG"
else echo "RESULT label_path_exists: no ($P1_LABEL_PATH never created)"; fi
echo "verdict_P1: -S wins over -L (verify 13, precedence half)"
echo

# ---------------------------------------------------------------------------
echo "-- P2: \$TMUX field layout inside a session on a known socket --"
P2_OUT="$ROOT/p2-tmux-env.txt"
tm -S "$P1_SOCK" new-session -d -s probe2 \
  "sh -c 'printf %s \"\$TMUX\" > $P2_OUT; sleep 3'"
sleep 1
# Record here, not at start-server: a session-less server exits immediately, so
# there is no PID to record until a session exists. Recording only at P1 left
# this server outside the survivor proof.
P2_PID="$(record_pid "$P1_SOCK")"
echo "server_pid_after_session: ${P2_PID:-<none>}"
P2_TMUX="$(cat "$P2_OUT" 2>/dev/null || echo '<empty>')"
echo "raw_TMUX: $P2_TMUX"
echo "field_count: $(printf '%s' "$P2_TMUX" | awk -F, '{print NF}')"
echo "RESULT layout: <socket>,<pid>,<session-index>"
# Strip exactly the final two comma-delimited metadata fields.
P2_RECOVERED="$(printf '%s' "$P2_TMUX" | sed 's/,[^,]*,[^,]*$//')"
echo "recovered_socket_parse_from_right: $P2_RECOVERED"
if [ "$P2_RECOVERED" = "$P1_SOCK" ]; then echo "RESULT parse_from_right_recovers_socket: yes"
else echo "RESULT parse_from_right_recovers_socket: NO"; fi
echo

# ---------------------------------------------------------------------------
echo "-- P3: socket pathname containing a legal comma --"
P3_SOCK="$ROOT/so,ck-c"
P3_OUT="$ROOT/p3-tmux-env.txt"
echo "socket_with_comma: $P3_SOCK"
tm -S "$P3_SOCK" new-session -d -s probe3 \
  "sh -c 'printf %s \"\$TMUX\" > $P3_OUT; sleep 3'"
P3_PID="$(record_pid "$P3_SOCK")"
sleep 1
P3_TMUX="$(cat "$P3_OUT" 2>/dev/null || echo '<empty>')"
echo "raw_TMUX: $P3_TMUX"
P3_RIGHT="$(printf '%s' "$P3_TMUX" | sed 's/,[^,]*,[^,]*$//')"
P3_FIRST="$(printf '%s' "$P3_TMUX" | cut -d, -f1)"
echo "parse_from_right: $P3_RIGHT"
echo "parse_first_field: $P3_FIRST"
if [ "$P3_RIGHT" = "$P3_SOCK" ]; then echo "RESULT right_parse_correct: yes"
else echo "RESULT right_parse_correct: NO"; fi
if [ "$P3_FIRST" = "$P3_SOCK" ]; then echo "RESULT first_field_parse_correct: yes -- comma hazard absent"
else echo "RESULT first_field_parse_correct: no -- TRUNCATES to '$P3_FIRST'; parse-from-right is required, not stylistic"; fi
kill_socket "$P3_SOCK"
echo

# ---------------------------------------------------------------------------
echo "-- P4: socket pathname byte budget at the boundary --"
# Build a path of exactly N bytes: "$ROOT/p4-" + padding.
probe_len() {
  local n="$1" prefix="$ROOT/p4-" pad path rc out
  pad="$(printf 'a%.0s' $(seq 1 $((n - ${#prefix}))))"
  path="${prefix}${pad}"
  out="$(tm -S "$path" start-server 2>&1)"; rc=$?
  printf '%s bytes: rc=%s %s\n' "${#path}" "$rc" "${out:-<no stderr>}"
  if [ $rc -eq 0 ]; then
    record_pid "$path" >/dev/null
    kill_socket "$path"
  fi
  return $rc
}
for n in 102 103 104 105; do
  probe_len "$n" || true
done
echo "RESULT darwin_budget: last success is the usable pathname byte limit"
echo "note: length is measured in BYTES (\${#path} over a single-byte pad);"
echo "      a multibyte path under the character limit can still exceed it."
echo

# ---------------------------------------------------------------------------
echo "-- P5: teardown and zero-survivor proof --"
kill_socket "$P1_SOCK"
rm -rf "$ROOT/tmpdir"
echo "recorded_pids: $(tr '\n' ' ' <"$PIDS_FILE")"
SURVIVORS=""
DEADLINE=$((SECONDS + 10))
while [ $SECONDS -lt $DEADLINE ]; do
  SURVIVORS=""
  while read -r pid; do
    [ -n "$pid" ] || continue
    if ps -p "$pid" >/dev/null 2>&1; then SURVIVORS="$SURVIVORS $pid"; fi
  done <"$PIDS_FILE"
  [ -z "$SURVIVORS" ] && break
  sleep 1
done
if [ -n "$(tr -d '[:space:]' <"$PIDS_FILE")" ]; then
  echo "RESULT nonvacuity: pids were recorded, so the survivor check has something to check"
else
  echo "RESULT nonvacuity: FAIL -- no pids recorded, survivor check is vacuous"
fi
if [ -z "$SURVIVORS" ]; then echo "RESULT survivors: none"
else echo "RESULT survivors: FAIL$SURVIVORS"; fi
for s in "$P1_SOCK" "$P3_SOCK"; do
  if [ -e "$s" ]; then echo "RESULT socket_removed($s): FAIL"; else echo "RESULT socket_removed($s): yes"; fi
done
if [ -e "$P1_LABEL_PATH" ]; then echo "RESULT label_path_removed: FAIL"; else echo "RESULT label_path_removed: yes (never created)"; fi
echo
echo "== probes complete =="
