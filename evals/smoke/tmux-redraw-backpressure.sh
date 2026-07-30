#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOOP_ROOT="${REPO_ROOT}/loop-fork"
LOOP_BIN="${LOOP_ROOT}/loop"
REAL_TMUX="$(command -v tmux)"
RUN_ID="tmux-redraw-smoke"
SESSION="loop-tmux-redraw-smoke-$$"
SOCKET="loop-tmux-redraw-smoke-$$"
if [[ -n "${LOOP_SMOKE_PARENT:-}" ]]; then
  SMOKE_ROOT="$(mktemp -d "${LOOP_SMOKE_PARENT%/}/tmux-redraw.XXXXXX")"
else
  SMOKE_ROOT="$(mktemp -d)"
fi
SMOKE_HOME="${SMOKE_ROOT}/home"
STALL_MARKER="${SMOKE_ROOT}/stall"
WRAPPER_BIN="${SMOKE_ROOT}/bin"
GOVERNESS_SHELL="${SHELL:-/bin/zsh}"
RUN_DIR=""
STATE_FILE=""
JOURNAL_FILE=""
SMOKE_PASSED=0

dump_file_tail() {
  local label="$1"
  local path="$2"
  echo "--- ${label}: ${path} (last 8192 bytes) ---" >&2
  if [[ -f "${path}" ]]; then
    tail -c 8192 "${path}" >&2 || true
    echo >&2
  else
    echo "missing" >&2
  fi
}

cleanup() {
  if [[ "${SMOKE_PASSED}" != "1" ]]; then
    echo "tmux redraw smoke failed; evidence preserved: ${SMOKE_ROOT}" >&2
    if [[ -n "${STATE_FILE}" ]]; then
      dump_file_tail "governess state" "${STATE_FILE}"
    fi
    if [[ -n "${JOURNAL_FILE}" ]]; then
      dump_file_tail "governess journal" "${JOURNAL_FILE}"
    fi
    echo "--- governess pane (last 40 lines) ---" >&2
    "${REAL_TMUX}" -L "${SOCKET}" capture-pane -p -S -40 \
      -t "${GOVERNESS_PANE:-}" >&2 || true
  fi
  "${REAL_TMUX}" -L "${SOCKET}" kill-server 2>/dev/null || true
  if [[ "${SMOKE_PASSED}" == "1" ]]; then
    rm -rf "${SMOKE_ROOT}"
  fi
}
trap cleanup EXIT

mkdir -p "${SMOKE_HOME}" "${WRAPPER_BIN}"
cp "${REPO_ROOT}/evals/fixtures/tmux-stall-wrapper.sh" "${WRAPPER_BIN}/tmux"
chmod +x "${WRAPPER_BIN}/tmux"

LEFT_PANE="$(
  "${REAL_TMUX}" -L "${SOCKET}" new-session -d -P -F '#{pane_id}' \
    -s "${SESSION}" -x 140 -y 42 \
    "while true; do printf 'Claude evidence │ 密度 🧭\\n'; sleep 1; done"
)"
RIGHT_PANE="$(
  "${REAL_TMUX}" -L "${SOCKET}" split-window -h -P -F '#{pane_id}' \
    -t "${LEFT_PANE}" \
    "while true; do printf 'Codex evidence │ 密度 🧭\\n'; sleep 1; done"
)"
GOVERNESS_PANE="$(
  "${REAL_TMUX}" -L "${SOCKET}" split-window -v -P -F '#{pane_id}' \
    -t "${LEFT_PANE}" "${GOVERNESS_SHELL}"
)"

SMOKE_HOME="${SMOKE_HOME}" \
SMOKE_LEFT="${LEFT_PANE}" \
SMOKE_RIGHT="${RIGHT_PANE}" \
SMOKE_GOVERNESS="${GOVERNESS_PANE}" \
SMOKE_SESSION="${SESSION}" \
SMOKE_RUN_ID="${RUN_ID}" \
  bun -e '
    import { mkdirSync } from "node:fs";
    import {
      createRunManifest,
      resolveRunStorage,
      writeRunManifest,
    } from "./loop-fork/src/loop/run-state.ts";
    const cwd = process.cwd();
    const home = process.env.SMOKE_HOME;
    const runId = process.env.SMOKE_RUN_ID;
    const storage = resolveRunStorage(runId, cwd, home);
    mkdirSync(storage.runDir, { recursive: true });
    writeRunManifest(
      storage.manifestPath,
      createRunManifest({
        cwd,
        governess: process.env.SMOKE_GOVERNESS,
        mode: "paired",
        pid: process.pid,
        repoId: storage.repoId,
        runId,
        status: "running",
        tmuxPaneGoverness: process.env.SMOKE_GOVERNESS,
        tmuxPaneLeft: process.env.SMOKE_LEFT,
        tmuxPaneLeftAgent: "claude",
        tmuxPaneRight: process.env.SMOKE_RIGHT,
        tmuxPaneRightAgent: "codex",
        tmuxSession: process.env.SMOKE_SESSION,
      })
    );
  ' \
  >/dev/null

RUN_DIR="$(
  HOME="${SMOKE_HOME}" bun -e '
    import { resolveRunStorage } from "./loop-fork/src/loop/run-state.ts";
    process.stdout.write(resolveRunStorage(process.argv[1]).runDir);
  ' "${RUN_ID}"
)"
STATE_FILE="${RUN_DIR}/governess-state.json"
JOURNAL_FILE="${RUN_DIR}/governess.jsonl"
GOVERNESS_COMMAND="env HOME='${SMOKE_HOME}' PATH='${WRAPPER_BIN}:${PATH}' LOOP_GOVERNESS_TICK=1 LOOP_SMOKE_REAL_TMUX='${REAL_TMUX}' LOOP_SMOKE_STALL_MARKER='${STALL_MARKER}' '${LOOP_BIN}' __governess '${RUN_ID}'"
"${REAL_TMUX}" -L "${SOCKET}" send-keys -t "${GOVERNESS_PANE}" -l -- "${GOVERNESS_COMMAND}"
"${REAL_TMUX}" -L "${SOCKET}" send-keys -t "${GOVERNESS_PANE}" Enter

for _ in {1..50}; do
  if [[ -f "${STATE_FILE}" ]] && \
    bun -e '
      const state = await Bun.file(process.argv[1]).json();
      process.exit(state.tick >= 1 ? 0 : 1);
    ' "${STATE_FILE}"; then
    break
  fi
  sleep 0.2
done

if [[ ! -f "${STATE_FILE}" ]] || ! \
  bun -e '
    const state = await Bun.file(process.argv[1]).json();
    process.exit(state.tick >= 1 ? 0 : 1);
  ' "${STATE_FILE}"; then
  echo "governess did not reach the first healthy tick" >&2
  exit 1
fi

if [[ "${LOOP_SMOKE_FORCE_FAILURE:-}" == "after-healthy" ]]; then
  echo "forced redraw-smoke failure after healthy tick" >&2
  exit 97
fi

HEALTHY_FRAME="$(
  "${REAL_TMUX}" -L "${SOCKET}" capture-pane -p -t "${GOVERNESS_PANE}"
)"
if [[ "${HEALTHY_FRAME}" == *"tmux degraded"* ]]; then
  echo "healthy board unexpectedly degraded" >&2
  exit 1
fi

touch "${STALL_MARKER}"
for _ in {1..35}; do
  if [[ -f "${STATE_FILE}" ]] && \
    bun -e '
      const state = await Bun.file(process.argv[1]).json();
      process.exit(state.tmuxControl ? 0 : 1);
    ' "${STATE_FILE}"; then
    break
  fi
  sleep 0.2
done

DEGRADED_FRAME="$(
  "${REAL_TMUX}" -L "${SOCKET}" capture-pane -p -t "${GOVERNESS_PANE}"
)"
if [[ "${DEGRADED_FRAME}" != *"tmux degraded"* ]]; then
  echo "degraded board marker was not rendered" >&2
  echo "--- state ---" >&2
  sed -n '1,8p' "${STATE_FILE}" >&2 || true
  echo "--- frame ---" >&2
  printf '%s\n' "${DEGRADED_FRAME}" >&2
  echo "--- log ---" >&2
  tail -8 "${RUN_DIR}/governess.jsonl" >&2 || true
  exit 1
fi

rm -f "${STALL_MARKER}"
for _ in {1..50}; do
  if [[ -f "${STATE_FILE}" ]] && \
    bun -e '
      const state = await Bun.file(process.argv[1]).json();
      process.exit(state.tick >= 3 && !state.tmuxControl ? 0 : 1);
    ' "${STATE_FILE}"; then
    break
  fi
  sleep 0.2
done

RECOVERED_FRAME="$(
  "${REAL_TMUX}" -L "${SOCKET}" capture-pane -p -t "${GOVERNESS_PANE}"
)"
if [[ "${RECOVERED_FRAME}" == *"tmux degraded"* ]]; then
  echo "board did not clear degraded state after tmux recovery" >&2
  exit 1
fi

bun -e '
  const state = await Bun.file(process.argv[1]).json();
  if (state.tick < 3 || state.tmuxControl) process.exit(1);
  console.log(JSON.stringify({ tick: state.tick, tmuxControl: "restored" }));
' "${STATE_FILE}"
SMOKE_PASSED=1
