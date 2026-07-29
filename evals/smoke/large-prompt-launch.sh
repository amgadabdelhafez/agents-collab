#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOOP_ROOT="${REPO_ROOT}/loop-fork"
FIXTURES="${REPO_ROOT}/runs/large-prompt-launch/artifacts/fake-bin"
SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/loop-large-prompt-smoke.XXXXXX")"
SMOKE_SOCKET="loop-large-prompt-$RANDOM-$$"

cleanup() {
  /opt/homebrew/bin/tmux -L "${SMOKE_SOCKET}" kill-server >/dev/null 2>&1 || true
  rm -rf "${SMOKE_ROOT}"
}
trap cleanup EXIT

cd "${LOOP_ROOT}"

bun test -t 'realistic 10KB prompt' tests/loop/tmux.test.ts
bun run build >/dev/null

mkdir -p "${SMOKE_ROOT}/bin" "${SMOKE_ROOT}/fail-bin" \
  "${SMOKE_ROOT}/home" "${SMOKE_ROOT}/repo"
cp "${FIXTURES}/gemini" "${SMOKE_ROOT}/bin/gemini"
cp "${FIXTURES}/cursor" "${SMOKE_ROOT}/bin/cursor"
cp "${FIXTURES}/tmux" "${SMOKE_ROOT}/bin/tmux"
cp "${FIXTURES}/gemini" "${SMOKE_ROOT}/fail-bin/gemini"
cp "${FIXTURES}/cursor" "${SMOKE_ROOT}/fail-bin/cursor"
cp "${FIXTURES}/tmux-no-session" "${SMOKE_ROOT}/fail-bin/tmux"
chmod +x "${SMOKE_ROOT}/bin/"* "${SMOKE_ROOT}/fail-bin/"*

git init -q "${SMOKE_ROOT}/repo"
PROMPT_PATH="${SMOKE_ROOT}/charter.md"
awk 'BEGIN { for (i = 0; i < 10257; i++) printf "x" }' >"${PROMPT_PATH}"

COMMON_ENV=(
  "HOME=${SMOKE_ROOT}/home"
  "LOOP_AU_PAIR_ENABLED=0"
  "LOOP_NANNY_ENABLED=0"
  "LOOP_RECON_PANES=0"
  "LOOP_SMOKE_TMUX_SOCKET=${SMOKE_SOCKET}"
  "LOOP_UTILITY_PANE=0"
)

cd "${SMOKE_ROOT}/repo"
env "${COMMON_ENV[@]}" "PATH=${SMOKE_ROOT}/bin:${PATH}" \
  "${LOOP_ROOT}/loop" --tmux --agent gemini --pair-with cursor \
  -p "${PROMPT_PATH}" >"${SMOKE_ROOT}/success.out" 2>"${SMOKE_ROOT}/success.err"

MANIFEST_PATH="$(find "${SMOKE_ROOT}/home/.loop/runs" -name manifest.json -type f -print -quit)"
if [ -z "${MANIFEST_PATH}" ]; then
  echo "large-prompt smoke: no run manifest" >&2
  exit 1
fi

read -r TMUX_SESSION LEFT_PANE RIGHT_PANE LEFT_AGENT RIGHT_AGENT < <(
  bun -e '
    const value = await Bun.file(process.argv[1]).json();
    console.log([
      value.tmuxSession ?? "",
      value.tmuxPaneLeft ?? "",
      value.tmuxPaneRight ?? "",
      value.tmuxPaneLeftAgent ?? "",
      value.tmuxPaneRightAgent ?? "",
    ].join(" "));
  ' "${MANIFEST_PATH}"
)

if [ -z "${TMUX_SESSION}" ]; then
  echo "large-prompt smoke: manifest tmuxSession is empty" >&2
  exit 1
fi
if [ "${LEFT_AGENT}" != "gemini" ] || [ "${RIGHT_AGENT}" != "cursor" ]; then
  echo "large-prompt smoke: unexpected agent pane mapping" >&2
  exit 1
fi
/opt/homebrew/bin/tmux -L "${SMOKE_SOCKET}" has-session -t "${TMUX_SESSION}"
LIVE_PANES="$(/opt/homebrew/bin/tmux -L "${SMOKE_SOCKET}" list-panes -t "${TMUX_SESSION}" -F '#{pane_id}')"
grep -Fqx "${LEFT_PANE}" <<<"${LIVE_PANES}"
grep -Fqx "${RIGHT_PANE}" <<<"${LIVE_PANES}"

set +e
env "${COMMON_ENV[@]}" "PATH=${SMOKE_ROOT}/fail-bin:${PATH}" \
  "${LOOP_ROOT}/loop" --tmux --agent gemini --pair-with cursor \
  -p "${PROMPT_PATH}" >"${SMOKE_ROOT}/failure.out" 2>"${SMOKE_ROOT}/failure.err"
FAILURE_STATUS=$?
set -e
if [ "${FAILURE_STATUS}" -eq 0 ]; then
  echo "large-prompt smoke: missing workspace exited successfully" >&2
  exit 1
fi
grep -Fq 'exited before attach' "${SMOKE_ROOT}/failure.err"

echo "large-prompt smoke: session=${TMUX_SESSION} panes=${LEFT_AGENT}:${LEFT_PANE},${RIGHT_AGENT}:${RIGHT_PANE} manifest=ok missing-workspace-exit=${FAILURE_STATUS}"
