#!/usr/bin/env bash
set -euo pipefail
exec 9>&2

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOOP_ROOT="${REPO_ROOT}/loop-fork"
REAL_TMUX="${LOOP_SMOKE_REAL_TMUX:-/opt/homebrew/bin/tmux}"
HASH_TUI="${REPO_ROOT}/evals/smoke/fixtures/hash-bound-tui.py"
TMUX_WRAPPER="${REPO_ROOT}/evals/smoke/fixtures/manifest-target-tmux.sh"
CONSUMER_HARNESS="${REPO_ROOT}/evals/smoke/tmux-socket-normalization-consumers.ts"
SELF="${REPO_ROOT}/evals/smoke/tmux-socket-normalization.sh"
SMOKE_ROOT="$(mktemp -d /tmp/loop-two-server.XXXXXX)"
SMOKE_ROOT="$(cd "${SMOKE_ROOT}" && pwd -P)"
HOME_ROOT="${SMOKE_ROOT}/home"
REPO="${SMOKE_ROOT}/repo"
BIN="${SMOKE_ROOT}/bin"
SOCKET_A="${SMOKE_ROOT}/a.sock"
TMUX_TMPDIR_B="${SMOKE_ROOT}/hostile-b"
SOCKET_B="${TMUX_TMPDIR_B}/tmux-$(id -u)/default"
TRACE="${SMOKE_ROOT}/tmux-trace.tsv"
PIDS="${SMOKE_ROOT}/owned-pids.tsv"
PROMPT="${SMOKE_ROOT}/charter.md"
CANDIDATE="${SMOKE_ROOT}/build/loop"
REGISTRY="${SMOKE_ROOT}/claude-registry.json"
SESSION="repo-loop-1"
CLEANED=0
TRAP_PROBE_CHILD="${LOOP_SMOKE_TRAP_PROBE_CHILD:-}"
TRAP_PROBE_READY="${LOOP_SMOKE_TRAP_PROBE_READY:-}"

record_pid() {
  local label="$1"
  local pid="$2"
  if ! [[ "${pid}" =~ ^[1-9][0-9]*$ ]]; then
    echo "two-server smoke: invalid ${label} pid ${pid:-missing}" >&2
    return 1
  fi
  printf '%s\t%s\n' "${label}" "${pid}" >>"${PIDS}"
}

record_server_and_panes() {
  local label="$1"
  local socket="$2"
  local server_pid
  server_pid="$("${REAL_TMUX}" -S "${socket}" display-message -p '#{pid}')"
  record_pid "${label}-server" "${server_pid}"
  while IFS= read -r pane_pid; do
    [ -n "${pane_pid}" ] && record_pid "${label}-pane" "${pane_pid}"
  done < <("${REAL_TMUX}" -S "${socket}" list-panes -a -F '#{pane_pid}')
}

live_recorded_count() {
  local count=0
  local label
  local pid
  if [ ! -s "${PIDS}" ]; then
    echo "two-server smoke: survivor proof has no recorded PIDs" >&2
    return 2
  fi
  while IFS=$'\t' read -r label pid; do
    if kill -0 "${pid}" >/dev/null 2>&1; then
      count=$((count + 1))
    fi
  done <"${PIDS}"
  printf '%s' "${count}"
}

assert_zero_survivors() {
  local pid_file="${1:-${PIDS}}"
  local label
  local pid
  local live=0
  if [ ! -s "${pid_file}" ]; then
    return 2
  fi
  while IFS=$'\t' read -r label pid; do
    if kill -0 "${pid}" >/dev/null 2>&1; then
      live=$((live + 1))
    fi
  done <"${pid_file}"
  [ "${live}" -eq 0 ]
}

cleanup_resources() {
  local status=0
  local label
  local pid
  "${REAL_TMUX}" -S "${SOCKET_A}" kill-server >/dev/null 2>&1 || true
  "${REAL_TMUX}" -S "${SOCKET_B}" kill-server >/dev/null 2>&1 || true
  if [ -s "${PIDS}" ]; then
    while IFS=$'\t' read -r label pid; do
      if kill -0 "${pid}" >/dev/null 2>&1; then
        kill "${pid}" >/dev/null 2>&1 || true
      fi
    done <"${PIDS}"
    for _attempt in $(seq 1 50); do
      if assert_zero_survivors; then
        break
      fi
      sleep 0.1
    done
    if ! assert_zero_survivors; then
      echo "two-server smoke: recorded processes survived exact cleanup" >&2
      status=1
    fi
  else
    echo "two-server smoke: cleanup had no recorded PIDs" >&2
    status=1
  fi
  if "${REAL_TMUX}" -S "${SOCKET_A}" has-session -t "${SESSION}" >/dev/null 2>&1 || \
    "${REAL_TMUX}" -S "${SOCKET_B}" has-session -t "${SESSION}" >/dev/null 2>&1; then
    echo "two-server smoke: session survived exact cleanup" >&2
    status=1
  fi
  rm -f "${SOCKET_A}" "${SOCKET_B}"
  if [ -e "${SOCKET_A}" ] || [ -e "${SOCKET_B}" ]; then
    echo "two-server smoke: socket survived exact cleanup" >&2
    status=1
  fi
  rm -rf "${SMOKE_ROOT}"
  if [ -e "${SMOKE_ROOT}" ]; then
    echo "two-server smoke: isolated product path survived cleanup" >&2
    status=1
  fi
  CLEANED=1
  return "${status}"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [ "${status}" -ne 0 ]; then
    for failure_log in \
      "${SMOKE_ROOT}/launch.err" \
      "${SMOKE_ROOT}/resume.err" \
      "${SMOKE_ROOT}/consumers.err" \
      "${SMOKE_ROOT}/consumers.jsonl"; do
      if [ -s "${failure_log}" ]; then
        echo "two-server smoke: failure log ${failure_log}" >&9
        sed -n '1,240p' "${failure_log}" >&9
      fi
    done
  fi
  if [ "${CLEANED}" -ne 1 ]; then
    cleanup_resources || status=1
  fi
  exit "${status}"
}
trap cleanup EXIT INT TERM

mkdir -p \
  "${BIN}" \
  "${HOME_ROOT}/.cache/loop/update" \
  "${SMOKE_ROOT}/build" \
  "${SMOKE_ROOT}/claude-config" \
  "${SMOKE_ROOT}/codex-home" \
  "${SMOKE_ROOT}/tmp" \
  "$(dirname "${SOCKET_B}")" \
  "${SMOKE_ROOT}/xdg-cache" \
  "${SMOKE_ROOT}/xdg-config" \
  "${SMOKE_ROOT}/xdg-data"
chmod 700 "${HOME_ROOT}" "${SMOKE_ROOT}/claude-config" "${SMOKE_ROOT}/codex-home" "${SMOKE_ROOT}/tmp"
: >"${TRACE}"
: >"${PIDS}"
set +e
assert_zero_survivors
EMPTY_PROOF_STATUS=$?
set -e
if [ "${EMPTY_PROOF_STATUS}" -ne 2 ]; then
  echo "two-server smoke: empty survivor proof did not fail closed" >&2
  exit 1
fi
printf '{"lastCheck":"2026-08-09T00:00:00Z"}\n' >"${HOME_ROOT}/.cache/loop/update/last-check.json"
cp "${HASH_TUI}" "${BIN}/opencode"
cp "${HASH_TUI}" "${BIN}/claude"
cp "${TMUX_WRAPPER}" "${BIN}/tmux"
chmod +x "${BIN}/"*

git init -q "${REPO}"
git -C "${REPO}" config user.email "two-server@example.invalid"
git -C "${REPO}" config user.name "Two Server Smoke"
printf '%s\n' '# two-server tmux fixture' >"${REPO}/README.md"
git -C "${REPO}" add README.md
git -C "${REPO}" commit -q -m fixture
{
  printf '%s\n' 'BEGIN-LARGE-CHARTER'
  awk 'BEGIN { for (i = 0; i < 10257; i++) printf "x" }'
  printf '%s\n' 'END-LARGE-CHARTER'
} >"${PROMPT}"

cd "${LOOP_ROOT}"
bun build --compile --outfile "${CANDIDATE}" src/cli.ts >/dev/null
CANDIDATE_SHA256="$(shasum -a 256 "${CANDIDATE}" | cut -d ' ' -f 1)"
TMUX_VERSION="$("${REAL_TMUX}" -V)"

run_trap_probe() {
  local mode="$1"
  local ready="${SMOKE_ROOT}/trap-${mode}.ready"
  local child_root
  local child_status
  LOOP_SMOKE_TRAP_PROBE_CHILD="${mode}" \
  LOOP_SMOKE_TRAP_PROBE_READY="${ready}" \
    "${SELF}" >"${SMOKE_ROOT}/trap-${mode}.out" \
    2>"${SMOKE_ROOT}/trap-${mode}.err" &
  local child_pid=$!
  record_pid "trap-${mode}" "${child_pid}"
  for _attempt in $(seq 1 100); do
    [ -s "${ready}" ] && break
    sleep 0.1
  done
  if [ ! -s "${ready}" ]; then
    echo "two-server smoke: ${mode} trap probe never became ready" >&2
    return 1
  fi
  child_root="$(sed -n '1p' "${ready}")"
  case "${child_root}" in
    /tmp/loop-two-server.* | /private/tmp/loop-two-server.*) ;;
    *)
      echo "two-server smoke: ${mode} trap probe returned unsafe root" >&2
      return 1
      ;;
  esac
  if [ "${mode}" = "signal" ]; then
    kill -TERM "${child_pid}"
  fi
  set +e
  wait "${child_pid}"
  child_status=$?
  set -e
  if [ "${mode}" = "assertion" ] && [ "${child_status}" -ne 97 ]; then
    echo "two-server smoke: assertion trap probe exited ${child_status}, expected 97" >&2
    return 1
  fi
  if [ -e "${child_root}" ]; then
    echo "two-server smoke: ${mode} trap probe left its isolated root" >&2
    return 1
  fi
}

if [ -z "${TRAP_PROBE_CHILD}" ]; then
  run_trap_probe assertion
  run_trap_probe signal
fi

"${REAL_TMUX}" -S "${SOCKET_B}" new-session -d -s "${SESSION}" \
  "printf 'D027-DECOY-B\\n'; exec sleep 300"
record_server_and_panes "b" "${SOCKET_B}"
DECOY_BEFORE="$("${REAL_TMUX}" -S "${SOCKET_B}" capture-pane -p -J -S -50 -t "${SESSION}")"
DECOY_BEFORE_SHA="$(printf '%s' "${DECOY_BEFORE}" | shasum -a 256 | cut -d ' ' -f 1)"
if [ -n "${TRAP_PROBE_CHILD}" ]; then
  case "${TRAP_PROBE_READY}" in
    /*) ;;
    *)
      echo "two-server smoke: trap probe ready path must be absolute" >&2
      exit 64
      ;;
  esac
  printf '%s\n' "${SMOKE_ROOT}" >"${TRAP_PROBE_READY}"
  if [ "${TRAP_PROBE_CHILD}" = "assertion" ]; then
    exit 97
  fi
  if [ "${TRAP_PROBE_CHILD}" = "signal" ]; then
    while :; do
      sleep 0.2
    done
    echo "two-server smoke: signal trap probe was not interrupted" >&2
    exit 98
  fi
  echo "two-server smoke: unknown trap probe mode ${TRAP_PROBE_CHILD}" >&2
  exit 64
fi

cd "${REPO}"
env -i \
  "CLAUDE_CONFIG_DIR=${SMOKE_ROOT}/claude-config" \
  "CODEX_HOME=${SMOKE_ROOT}/codex-home" \
  "HOME=${HOME_ROOT}" \
  LANG=C \
  "LOGNAME=$(id -un)" \
  LOOP_AU_PAIR_ENABLED=0 \
  LOOP_NANNY_ENABLED=0 \
  LOOP_RECON_PANES=0 \
  LOOP_RUN_ID=1 \
  "LOOP_SMOKE_EXPECTED_TMUX_SOCKET=${SOCKET_A}" \
  "LOOP_SMOKE_REAL_TMUX=${REAL_TMUX}" \
  "LOOP_SMOKE_TMUX_TRACE=${TRACE}" \
  "LOOP_SMOKE_TRACE_PATH=${SMOKE_ROOT}/agent-trace.log" \
  "LOOP_TMUX_SOCKET=${SOCKET_A}" \
  LOOP_UTILITY_PANE=0 \
  "PATH=${BIN}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  SHELL=/bin/sh \
  TERM=xterm-256color \
  "TMPDIR=${SMOKE_ROOT}/tmp" \
  "USER=$(id -un)" \
  "XDG_CACHE_HOME=${SMOKE_ROOT}/xdg-cache" \
  "XDG_CONFIG_HOME=${SMOKE_ROOT}/xdg-config" \
  "XDG_DATA_HOME=${SMOKE_ROOT}/xdg-data" \
  "${CANDIDATE}" --tmux --agent oss --pair-with claude \
  --governess --governess-dry-run -p "${PROMPT}" \
  >"${SMOKE_ROOT}/launch.out" 2>"${SMOKE_ROOT}/launch.err" &
LAUNCH_PID=$!
record_pid launcher "${LAUNCH_PID}"
wait "${LAUNCH_PID}"

MANIFEST_PATH="$(find "${HOME_ROOT}/.loop/runs" -name manifest.json -type f -print -quit)"
if [ -z "${MANIFEST_PATH}" ]; then
  echo "two-server smoke: compiled producer wrote no manifest" >&2
  exit 1
fi
RUN_DIR="$(dirname "${MANIFEST_PATH}")"
RECORDED_SOCKET="$(bun -e 'const m=await Bun.file(process.argv[1]).json(); console.log(m.tmuxSocket ?? "")' "${MANIFEST_PATH}")"
RECORDED_SESSION="$(bun -e 'const m=await Bun.file(process.argv[1]).json(); console.log(m.tmuxSession ?? "")' "${MANIFEST_PATH}")"
if [ "${RECORDED_SOCKET}" != "${SOCKET_A}" ] || [ "${RECORDED_SESSION}" != "${SESSION}" ]; then
  echo "two-server smoke: producer target ${RECORDED_SOCKET}/${RECORDED_SESSION} != A/${SESSION}" >&2
  exit 1
fi
if ! awk -F '\t' -v socket="${SOCKET_A}" -v session="${SESSION}" '
  $2 == "-V" { next }
  $2 != "-S" || $3 != socket { exit 1 }
  $4 == "new-session" {
    for (i = 5; i <= NF; i += 1) if ($i == session) found = 1
  }
  END { if (!found) exit 1 }
' "${TRACE}"; then
  echo "two-server smoke: producer launch trace omitted exact A new-session" >&2
  exit 1
fi
printf '%s\n' '{"consumer":"producer-launch","detail":"compiled manifest bound to A","status":"pass"}' \
  >"${SMOKE_ROOT}/consumers.jsonl"
"${REAL_TMUX}" -S "${SOCKET_A}" has-session -t "${SESSION}"
record_server_and_panes "a" "${SOCKET_A}"

RESUME_TRACE_LINES_BEFORE="$(wc -l <"${TRACE}" | tr -d ' ')"
env -i \
  "CLAUDE_CONFIG_DIR=${SMOKE_ROOT}/claude-config" \
  "CODEX_HOME=${SMOKE_ROOT}/codex-home" \
  "HOME=${HOME_ROOT}" \
  LANG=C \
  "LOGNAME=$(id -un)" \
  "LOOP_SMOKE_EXPECTED_TMUX_SOCKET=${SOCKET_A}" \
  "LOOP_SMOKE_REAL_TMUX=${REAL_TMUX}" \
  "LOOP_SMOKE_TMUX_TRACE=${TRACE}" \
  "LOOP_TMUX_SOCKET=${SOCKET_B}" \
  "PATH=${BIN}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  SHELL=/bin/sh \
  TERM=xterm-256color \
  "TMUX=${SOCKET_B},999,0" \
  "TMUX_TMPDIR=${TMUX_TMPDIR_B}" \
  "USER=$(id -un)" \
  "${CANDIDATE}" --tmux --session 1 -p "${PROMPT}" \
  >"${SMOKE_ROOT}/resume.out" 2>"${SMOKE_ROOT}/resume.err" &
RESUME_PID=$!
record_pid resume "${RESUME_PID}"
wait "${RESUME_PID}"
RESUME_TRACE_DELTA="$(tail -n "+$((RESUME_TRACE_LINES_BEFORE + 1))" "${TRACE}")"
if ! awk -F '\t' -v socket="${SOCKET_A}" -v session="${SESSION}" '
  NF == 0 { next }
  $2 == "-V" { next }
  $2 != "-S" || $3 != socket { exit 1 }
  $4 == "has-session" {
    for (i = 5; i <= NF; i += 1) if ($i == session) found = 1
  }
  END { if (!found) exit 1 }
' <<<"${RESUME_TRACE_DELTA}"; then
  echo "two-server smoke: resume issued no exact A session probe" >&2
  exit 1
fi
RESUME_RECORDED_SOCKET="$(bun -e 'const m=await Bun.file(process.argv[1]).json(); console.log(m.tmuxSocket ?? "")' "${MANIFEST_PATH}")"
RESUME_RECORDED_SESSION="$(bun -e 'const m=await Bun.file(process.argv[1]).json(); console.log(m.tmuxSession ?? "")' "${MANIFEST_PATH}")"
if [ "${RESUME_RECORDED_SOCKET}" != "${SOCKET_A}" ] || \
  [ "${RESUME_RECORDED_SESSION}" != "${SESSION}" ]; then
  echo "two-server smoke: hostile resume changed target to ${RESUME_RECORDED_SOCKET}/${RESUME_RECORDED_SESSION}" >&2
  exit 1
fi
if ! "${REAL_TMUX}" -S "${SOCKET_A}" has-session -t "${SESSION}"; then
  echo "two-server smoke: resume did not preserve live A session" >&2
  exit 1
fi
printf '%s\n' '{"consumer":"resume-reattach","detail":"hostile-B resume retained A","status":"pass"}' \
  >>"${SMOKE_ROOT}/consumers.jsonl"

env \
  "HOME=${HOME_ROOT}" \
  "LOOP_SMOKE_EXPECTED_TMUX_SOCKET=${SOCKET_A}" \
  "LOOP_SMOKE_REAL_TMUX=${REAL_TMUX}" \
  "LOOP_SMOKE_TMUX_TRACE=${TRACE}" \
  "LOOP_TMUX_SOCKET=${SOCKET_B}" \
  "PATH=${BIN}:${PATH}" \
  "TMUX=${SOCKET_B},999,0" \
  "TMUX_TMPDIR=${TMUX_TMPDIR_B}" \
  bun "${CONSUMER_HARNESS}" \
  "${HOME_ROOT}" "${RUN_DIR}" "${MANIFEST_PATH}" \
  "${SOCKET_A}" "${SOCKET_B}" "${REGISTRY}" \
  >>"${SMOKE_ROOT}/consumers.jsonl" 2>"${SMOKE_ROOT}/consumers.err" &
HARNESS_PID=$!
record_pid consumer-harness "${HARNESS_PID}"
wait "${HARNESS_PID}"

EXPECTED_CONSUMERS=(
  producer-launch resume-reattach manifest-target tmux-control-sync
  tmux-control-async attach-hint tmux-default-attach
  bridge-status-schema bridge-capture bridge-buffer-load bridge-buffer-paste
  bridge-send bridge-topology-non-effect claude-config-gc
  run-process-cleanup launch-reservation paired-options codex-tmux-proxy
  proxy-stop-non-effect panel governess-liveness governess-effect
  governess-handover governess-destructive-non-effect governess-pane-liveness
  governess-replay consumer-matrix
)
for consumer in "${EXPECTED_CONSUMERS[@]}"; do
  if [ "$(grep -Fc "\"consumer\":\"${consumer}\"" "${SMOKE_ROOT}/consumers.jsonl")" -ne 1 ]; then
    echo "two-server smoke: missing or duplicate ${consumer} assertion" >&2
    sed -n '1,200p' "${SMOKE_ROOT}/consumers.jsonl" >&2
    exit 1
  fi
done

if ! awk -F '\t' -v socket="${SOCKET_A}" '
  $2 == "-V" { if (NF != 2) exit 1; version += 1; next }
  { contact += 1; if ($2 != "-S" || $3 != socket) exit 1 }
  END { if (version < 1 || contact < 1) exit 1 }
' "${TRACE}"; then
  echo "two-server smoke: wrapper trace contains non-A or malformed contact" >&2
  sed -n '1,240p' "${TRACE}" >&2
  exit 1
fi

DECOY_AFTER="$("${REAL_TMUX}" -S "${SOCKET_B}" capture-pane -p -J -S -50 -t "${SESSION}")"
DECOY_AFTER_SHA="$(printf '%s' "${DECOY_AFTER}" | shasum -a 256 | cut -d ' ' -f 1)"
if [ "${DECOY_AFTER_SHA}" != "${DECOY_BEFORE_SHA}" ]; then
  echo "two-server smoke: decoy B changed under hostile consumer matrix" >&2
  exit 1
fi

LIVE_CONTROL="$(live_recorded_count)"
set +e
assert_zero_survivors
POSITIVE_PROOF_STATUS=$?
set -e
if [ "${POSITIVE_PROOF_STATUS}" -ne 1 ] || [ "${LIVE_CONTROL}" -eq 0 ]; then
  echo "two-server smoke: positive survivor control did not fail on a live recorded PID" >&2
  exit 1
fi

CONSUMER_COUNT="${#EXPECTED_CONSUMERS[@]}"
TRACE_CONTACTS="$(awk -F '\t' '$2 != "-V" { count += 1 } END { print count + 0 }' "${TRACE}")"
cleanup_resources

echo "two-server smoke: candidate-sha256=${CANDIDATE_SHA256} tmux=${TMUX_VERSION// /_} producer=A session=${SESSION} hostile=B consumers=${CONSUMER_COUNT} exact-a-contacts=${TRACE_CONTACTS} decoy-sha256=${DECOY_AFTER_SHA} trap-exit=pass trap-signal=pass positive-live-pids=${LIVE_CONTROL} post-cleanup-survivors=0 sockets=0 sessions=0 product-paths=0"
