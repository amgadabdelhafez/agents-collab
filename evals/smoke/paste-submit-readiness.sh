#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOOP_ROOT="${REPO_ROOT}/loop-fork"
HASH_TUI="${REPO_ROOT}/evals/smoke/fixtures/hash-bound-tui.py"
TMUX_WRAPPER="${REPO_ROOT}/evals/smoke/fixtures/isolated-tmux.sh"
SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/loop-bridge-nudge-smoke.XXXXXX")"
SMOKE_ROOT="$(cd "${SMOKE_ROOT}" && pwd -P)"
SMOKE_SOCKET="${SMOKE_ROOT}/tmux.sock"

cleanup() {
  local status=$?
  trap - EXIT
  /opt/homebrew/bin/tmux -S "${SMOKE_SOCKET}" kill-server >/dev/null 2>&1 || true
  rm -rf "${SMOKE_ROOT}"
  exit "${status}"
}
trap cleanup EXIT

manifest_field() {
  bun -e 'const m=await Bun.file(process.argv[1]).json(); console.log(m[process.argv[2]] ?? "")' "$1" "$2"
}

pane_for_agent() {
  bun -e '
    const m=await Bun.file(process.argv[1]).json();
    const agent=process.argv[2];
    if (m.tmuxPaneLeftAgent === agent) console.log(m.tmuxPaneLeft ?? "");
    else if (m.tmuxPaneRightAgent === agent) console.log(m.tmuxPaneRight ?? "");
    else process.exit(2);
  ' "$1" "$2"
}

wait_for_pane_text() {
  local pane="$1"
  local text="$2"
  local output=""
  for _attempt in $(seq 1 40); do
    output="$(/opt/homebrew/bin/tmux -S "${SMOKE_SOCKET}" capture-pane -p -J -S -200 -t "${pane}")"
    if grep -Fq "${text}" <<<"${output}"; then
      printf '%s' "${output}"
      return 0
    fi
    sleep 0.25
  done
  printf '%s\n' "${output}" >&2
  return 1
}

mkdir -p "${SMOKE_ROOT}/bin" "${SMOKE_ROOT}/home" "${SMOKE_ROOT}/repo"
cp "${HASH_TUI}" "${SMOKE_ROOT}/bin/claude"
cp "${HASH_TUI}" "${SMOKE_ROOT}/bin/gemini"
cp "${TMUX_WRAPPER}" "${SMOKE_ROOT}/bin/tmux"
chmod +x "${SMOKE_ROOT}/bin/"*
git init -q "${SMOKE_ROOT}/repo"
PROMPT_PATH="${SMOKE_ROOT}/charter.md"
{
  printf 'BEGIN-LARGE-CHARTER\n'
  awk 'BEGIN { for (i = 0; i < 10257; i++) printf "x" }'
} >"${PROMPT_PATH}"

cd "${LOOP_ROOT}"
bun run build >/dev/null

cd "${SMOKE_ROOT}/repo"
set +e
env \
  "HOME=${SMOKE_ROOT}/home" \
  LOOP_AU_PAIR_ENABLED=0 \
  LOOP_NANNY_ENABLED=0 \
  LOOP_RECON_PANES=0 \
  "LOOP_SMOKE_REAL_TMUX=/opt/homebrew/bin/tmux" \
  "LOOP_TMUX_SOCKET=${SMOKE_SOCKET}" \
  LOOP_UTILITY_PANE=0 \
  "PATH=${SMOKE_ROOT}/bin:${PATH}" \
  "${LOOP_ROOT}/loop" --tmux --agent gemini --pair-with claude \
  -p "${PROMPT_PATH}" >"${SMOKE_ROOT}/launch.out" 2>"${SMOKE_ROOT}/launch.err"
LAUNCH_STATUS=$?
set -e
if [ "${LAUNCH_STATUS}" -ne 0 ]; then
  sed -n '1,160p' "${SMOKE_ROOT}/launch.out" >&2
  sed -n '1,160p' "${SMOKE_ROOT}/launch.err" >&2
  exit "${LAUNCH_STATUS}"
fi

MANIFEST_PATH="$(find "${SMOKE_ROOT}/home/.loop/runs" -name manifest.json -type f -print -quit)"
if [ -z "${MANIFEST_PATH}" ]; then
  echo "bridge-nudge smoke: no run manifest" >&2
  exit 1
fi
TMUX_SESSION="$(manifest_field "${MANIFEST_PATH}" tmuxSession)"
RECORDED_SOCKET="$(manifest_field "${MANIFEST_PATH}" tmuxSocket)"
GEMINI_PANE="$(pane_for_agent "${MANIFEST_PATH}" gemini)"
CLAUDE_PANE="$(pane_for_agent "${MANIFEST_PATH}" claude)"
if [ "${RECORDED_SOCKET}" != "${SMOKE_SOCKET}" ]; then
  echo "bridge-nudge smoke: manifest socket ${RECORDED_SOCKET:-missing} != ${SMOKE_SOCKET}" >&2
  exit 1
fi
if [ -z "${TMUX_SESSION}" ] || [ -z "${GEMINI_PANE}" ] || [ -z "${CLAUDE_PANE}" ]; then
  echo "bridge-nudge smoke: incomplete pane manifest" >&2
  exit 1
fi
/opt/homebrew/bin/tmux -S "${SMOKE_SOCKET}" has-session -t "${TMUX_SESSION}"
wait_for_pane_text "${GEMINI_PANE}" "BOOTSTRAP_VERIFIED gemini" >/dev/null
wait_for_pane_text "${CLAUDE_PANE}" "BOOTSTRAP_VERIFIED claude" >/dev/null

RUN_DIR="$(dirname "${MANIFEST_PATH}")"
BRIDGE_BODY_PATH="${SMOKE_ROOT}/bridge-body.txt"
BRIDGE_REQUEST_PATH="${SMOKE_ROOT}/bridge-request.jsonl"
{
  printf 'COMPILED-BRIDGE-SENTINEL\n'
  awk 'BEGIN { for (i = 0; i < 9279; i++) printf "b" }'
} >"${BRIDGE_BODY_PATH}"
bun -e '
  const message = await Bun.file(process.argv[1]).text();
  console.log(JSON.stringify({
    id: 1,
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      arguments: { message, subject: "FULL-BODY-MUST-STAY-IN-LEDGER", target: "gemini" },
      name: "send_message",
    },
  }));
' "${BRIDGE_BODY_PATH}" >"${BRIDGE_REQUEST_PATH}"

env \
  "HOME=${SMOKE_ROOT}/home" \
  "LOOP_SMOKE_REAL_TMUX=/opt/homebrew/bin/tmux" \
  "LOOP_TMUX_SOCKET=${SMOKE_SOCKET}" \
  "PATH=${SMOKE_ROOT}/bin:${PATH}" \
  "${LOOP_ROOT}/loop" __bridge-mcp "${RUN_DIR}" claude \
  <"${BRIDGE_REQUEST_PATH}" >"${SMOKE_ROOT}/bridge.out" 2>"${SMOKE_ROOT}/bridge.err"

GEMINI_OUTPUT="$(wait_for_pane_text "${GEMINI_PANE}" "NUDGE_SUBMITTED gemini")"
if grep -Fq 'COMPILED-BRIDGE-SENTINEL' <<<"${GEMINI_OUTPUT}"; then
  echo "bridge-nudge smoke: bridge body leaked into terminal" >&2
  exit 1
fi
if grep -Fq 'FULL-BODY-MUST-STAY-IN-LEDGER' <<<"${GEMINI_OUTPUT}"; then
  echo "bridge-nudge smoke: bridge subject leaked into terminal" >&2
  exit 1
fi
grep -Fq 'NUDGE_RECEIVED gemini bytes=53 text="Bridge: 1 message waiting. Call receive_messages now."' <<<"${GEMINI_OUTPUT}"
if [ "$(grep -Fc 'NUDGE_RECEIVED gemini' <<<"${GEMINI_OUTPUT}")" -ne 1 ]; then
  echo "bridge-nudge smoke: duplicate terminal notifications" >&2
  exit 1
fi
grep -Eq 'accepted [^" ]+ for gemini delivery' "${SMOKE_ROOT}/bridge.out"

MESSAGE_ID="$(bun -e '
  import { readFileSync } from "node:fs";
  const events = readFileSync(process.argv[1], "utf8").trim().split(/\r?\n/).map(JSON.parse);
  const message = events.find((event) => event.kind === "message" && event.target === "gemini" && event.message?.startsWith("COMPILED-BRIDGE-SENTINEL"));
  if (!message) throw new Error("full bridge body missing from ledger");
  const matching = events.filter((event) => event.id === message.id);
  if (!matching.some((event) => event.kind === "notified")) throw new Error("notification evidence missing");
  if (matching.some((event) => event.kind === "delivered")) throw new Error("notification incorrectly resolved message");
  console.log(message.id);
' "${RUN_DIR}/bridge.jsonl")"

printf '%s\n' '{"id":2,"jsonrpc":"2.0","method":"tools/call","params":{"arguments":{},"name":"receive_messages"}}' >"${SMOKE_ROOT}/receive-request.jsonl"
env \
  "HOME=${SMOKE_ROOT}/home" \
  "LOOP_SMOKE_REAL_TMUX=/opt/homebrew/bin/tmux" \
  "LOOP_TMUX_SOCKET=${SMOKE_SOCKET}" \
  "PATH=${SMOKE_ROOT}/bin:${PATH}" \
  "${LOOP_ROOT}/loop" __bridge-mcp "${RUN_DIR}" gemini \
  <"${SMOKE_ROOT}/receive-request.jsonl" >"${SMOKE_ROOT}/receive.out" 2>"${SMOKE_ROOT}/receive.err"

bun -e '
  import { readFileSync } from "node:fs";
  const response = JSON.parse(readFileSync(process.argv[1], "utf8").trim());
  const inbox = JSON.parse(response.result.content[0].text);
  if (inbox.length !== 1) throw new Error(`expected one inbox message, got ${inbox.length}`);
  if (!inbox[0].message.startsWith("COMPILED-BRIDGE-SENTINEL\n")) throw new Error("receive_messages omitted full body");
  if (!inbox[0].message.endsWith("b".repeat(9279))) throw new Error("receive_messages body truncated");
  const events = readFileSync(process.argv[2], "utf8").trim().split(/\r?\n/).map(JSON.parse);
  const matching = events.filter((event) => event.id === process.argv[3]);
  if (matching.filter((event) => event.kind === "notified").length !== 1) throw new Error("expected one notification event");
  if (matching.filter((event) => event.kind === "delivered").length !== 1) throw new Error("expected one delivered resolution");
' "${SMOKE_ROOT}/receive.out" "${RUN_DIR}/bridge.jsonl" "${MESSAGE_ID}"

echo "bridge-nudge smoke: session=${TMUX_SESSION} gemini=${GEMINI_PANE} claude=${CLAUDE_PANE} nudge-bytes=53 body=ledger-only receive=complete notification=unresolved-until-pull"
