#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOOP_ROOT="${REPO_ROOT}/loop-fork"
FIXTURES="${REPO_ROOT}/runs/paste-submit-readiness/artifacts"
SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/loop-paste-submit-smoke.XXXXXX")"
SMOKE_SOCKET="loop-paste-submit-$RANDOM-$$"

cleanup() {
  /opt/homebrew/bin/tmux -L "${SMOKE_SOCKET}" kill-server >/dev/null 2>&1 || true
  rm -rf "${SMOKE_ROOT}"
}
trap cleanup EXIT

mkdir -p "${SMOKE_ROOT}/bin" "${SMOKE_ROOT}/home" "${SMOKE_ROOT}/repo"
cp "${FIXTURES}/fake-delayed-tui.py" "${SMOKE_ROOT}/bin/claude"
cp "${FIXTURES}/fake-delayed-tui.py" "${SMOKE_ROOT}/bin/gemini"
cp "${FIXTURES}/tmux" "${SMOKE_ROOT}/bin/tmux"
chmod +x "${SMOKE_ROOT}/bin/"*
git init -q "${SMOKE_ROOT}/repo"
PROMPT_PATH="${SMOKE_ROOT}/charter.md"
awk 'BEGIN { for (i = 0; i < 10257; i++) printf "x" }' >"${PROMPT_PATH}"

cd "${LOOP_ROOT}"
bun run build >/dev/null

cd "${SMOKE_ROOT}/repo"
set +e
env \
  "HOME=${SMOKE_ROOT}/home" \
  "LOOP_AU_PAIR_ENABLED=0" \
  "LOOP_NANNY_ENABLED=0" \
  "LOOP_RECON_PANES=0" \
  "LOOP_SMOKE_TMUX_SOCKET=${SMOKE_SOCKET}" \
  "LOOP_UTILITY_PANE=0" \
  "PATH=${SMOKE_ROOT}/bin:${PATH}" \
  "${LOOP_ROOT}/loop" --tmux --agent gemini --pair-with claude \
  -p "${PROMPT_PATH}" >"${SMOKE_ROOT}/launch.out" 2>"${SMOKE_ROOT}/launch.err"
LAUNCH_STATUS=$?
set -e
if [ "${LAUNCH_STATUS}" -ne 0 ]; then
  cat "${SMOKE_ROOT}/launch.out" >&2
  cat "${SMOKE_ROOT}/launch.err" >&2
  exit "${LAUNCH_STATUS}"
fi

MANIFEST_PATH="$(find "${SMOKE_ROOT}/home/.loop/runs" -name manifest.json -type f -print -quit)"
read -r TMUX_SESSION LEFT_PANE RIGHT_PANE < <(
  bun -e '
    const value = await Bun.file(process.argv[1]).json();
    console.log([
      value.tmuxSession ?? "",
      value.tmuxPaneLeft ?? "",
      value.tmuxPaneRight ?? "",
    ].join(" "));
  ' "${MANIFEST_PATH}"
)

for _attempt in $(seq 1 20); do
  LEFT_OUTPUT="$(/opt/homebrew/bin/tmux -L "${SMOKE_SOCKET}" capture-pane -p -t "${LEFT_PANE}")"
  RIGHT_OUTPUT="$(/opt/homebrew/bin/tmux -L "${SMOKE_SOCKET}" capture-pane -p -t "${RIGHT_PANE}")"
  if grep -Fq "SUBMITTED claude" <<<"${LEFT_OUTPUT}" && \
     grep -Fq "SUBMITTED gemini" <<<"${RIGHT_OUTPUT}"; then
    break
  fi
  sleep 0.25
done

if grep -Fq "EARLY_ENTER" <<<"${LEFT_OUTPUT}${RIGHT_OUTPUT}"; then
  echo "paste-submit smoke: Enter arrived before paste rendering" >&2
  exit 1
fi
grep -Fq "SUBMITTED claude" <<<"${LEFT_OUTPUT}"
grep -Fq "SUBMITTED gemini" <<<"${RIGHT_OUTPUT}"
/opt/homebrew/bin/tmux -L "${SMOKE_SOCKET}" has-session -t "${TMUX_SESSION}"

echo "paste-submit smoke: session=${TMUX_SESSION} claude=${LEFT_PANE}:submitted gemini=${RIGHT_PANE}:submitted early-enter=absent"
