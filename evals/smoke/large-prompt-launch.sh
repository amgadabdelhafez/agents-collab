#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOOP_ROOT="${REPO_ROOT}/loop-fork"
FIXTURES="${REPO_ROOT}/runs/large-prompt-launch/artifacts/fake-bin"
HASH_TUI="${REPO_ROOT}/evals/smoke/fixtures/hash-bound-tui.py"
SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/loop-large-prompt-smoke.XXXXXX")"
SMOKE_SOCKET="loop-large-prompt-$RANDOM-$$"
HASH_SMOKE_SOCKET="loop-hash-mismatch-$RANDOM-$$"

cleanup() {
  local status=$?
  local socket_dir="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)"
  trap - EXIT
  /opt/homebrew/bin/tmux -L "${SMOKE_SOCKET}" kill-server >/dev/null 2>&1 || true
  /opt/homebrew/bin/tmux -L "${HASH_SMOKE_SOCKET}" kill-server >/dev/null 2>&1 || true
  if [ -S "${socket_dir}/${SMOKE_SOCKET}" ]; then
    mv "${socket_dir}/${SMOKE_SOCKET}" "${SMOKE_ROOT}/${SMOKE_SOCKET}.socket"
  fi
  if [ -S "${socket_dir}/${HASH_SMOKE_SOCKET}" ]; then
    mv "${socket_dir}/${HASH_SMOKE_SOCKET}" "${SMOKE_ROOT}/${HASH_SMOKE_SOCKET}.socket"
  fi
  rm -rf "${SMOKE_ROOT}"
  exit "${status}"
}
trap cleanup EXIT

make_agent_bin() {
  local target="$1"
  mkdir -p "${target}"
  cp "${HASH_TUI}" "${target}/gemini"
  cp "${HASH_TUI}" "${target}/cursor"
  cp "${FIXTURES}/tmux" "${target}/tmux"
  chmod +x "${target}/"*
}

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
  local socket="$1"
  local pane="$2"
  local text="$3"
  local output=""
  for _attempt in $(seq 1 40); do
    output="$(/opt/homebrew/bin/tmux -L "${socket}" capture-pane -p -J -S -200 -t "${pane}")"
    if grep -Fq "${text}" <<<"${output}"; then
      printf '%s' "${output}"
      return 0
    fi
    sleep 0.25
  done
  printf '%s\n' "${output}" >&2
  return 1
}

cd "${LOOP_ROOT}"
bun run test:file -- -t \
  'transports a realistic charter through hash-bound pointer bootstraps' \
  tests/loop/tmux.test.ts
bun run build >/dev/null

mkdir -p "${SMOKE_ROOT}/home" "${SMOKE_ROOT}/repo" \
  "${SMOKE_ROOT}/hash-home" "${SMOKE_ROOT}/hash-repo" \
  "${SMOKE_ROOT}/hash-bin" "${SMOKE_ROOT}/fail-bin"
make_agent_bin "${SMOKE_ROOT}/bin"
cp "${HASH_TUI}" "${SMOKE_ROOT}/hash-bin/gemini"
cp "${FIXTURES}/cursor" "${SMOKE_ROOT}/hash-bin/cursor"
cp "${FIXTURES}/tmux" "${SMOKE_ROOT}/hash-bin/tmux"
cp "${HASH_TUI}" "${SMOKE_ROOT}/fail-bin/gemini"
cp "${HASH_TUI}" "${SMOKE_ROOT}/fail-bin/cursor"
cp "${FIXTURES}/tmux-no-session" "${SMOKE_ROOT}/fail-bin/tmux"
chmod +x "${SMOKE_ROOT}/hash-bin/"* "${SMOKE_ROOT}/fail-bin/"*
git init -q "${SMOKE_ROOT}/repo"
git init -q "${SMOKE_ROOT}/hash-repo"
PROMPT_PATH="${SMOKE_ROOT}/charter.md"
{
  printf 'BEGIN-LARGE-CHARTER\n'
  awk 'BEGIN { for (i = 0; i < 10257; i++) printf "x" }'
} >"${PROMPT_PATH}"

COMMON_ENV=(
  "LOOP_AU_PAIR_ENABLED=0"
  "LOOP_NANNY_ENABLED=0"
  "LOOP_RECON_PANES=0"
  "LOOP_SMOKE_TMUX_SOCKET=${SMOKE_SOCKET}"
  "LOOP_UTILITY_PANE=0"
)

cd "${SMOKE_ROOT}/repo"
env "${COMMON_ENV[@]}" "HOME=${SMOKE_ROOT}/home" \
  "PATH=${SMOKE_ROOT}/bin:${PATH}" \
  "${LOOP_ROOT}/loop" --tmux --agent gemini --pair-with cursor \
  -p "${PROMPT_PATH}" >"${SMOKE_ROOT}/success.out" 2>"${SMOKE_ROOT}/success.err"

MANIFEST_PATH="$(find "${SMOKE_ROOT}/home/.loop/runs" -name manifest.json -type f -print -quit)"
if [ -z "${MANIFEST_PATH}" ]; then
  echo "large-prompt smoke: no run manifest" >&2
  exit 1
fi

TMUX_SESSION="$(manifest_field "${MANIFEST_PATH}" tmuxSession)"
LEFT_PANE="$(manifest_field "${MANIFEST_PATH}" tmuxPaneLeft)"
RIGHT_PANE="$(manifest_field "${MANIFEST_PATH}" tmuxPaneRight)"
LEFT_AGENT="$(manifest_field "${MANIFEST_PATH}" tmuxPaneLeftAgent)"
RIGHT_AGENT="$(manifest_field "${MANIFEST_PATH}" tmuxPaneRightAgent)"
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
wait_for_pane_text "${SMOKE_SOCKET}" "${LEFT_PANE}" "BOOTSTRAP_VERIFIED gemini" >/dev/null
wait_for_pane_text "${SMOKE_SOCKET}" "${RIGHT_PANE}" "BOOTSTRAP_VERIFIED cursor" >/dev/null

bun -e '
  import { createHash } from "node:crypto";
  import { dirname, join } from "node:path";
  import { readFileSync, statSync } from "node:fs";
  const manifestPath = process.argv[1];
  const sentinel = process.argv[2];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const runDir = dirname(manifestPath);
  if (!manifest.tmuxSession) throw new Error("empty tmuxSession");
  for (const agent of ["gemini", "cursor"]) {
    const binding = manifest.launchCharters?.[agent];
    if (!binding?.path || !binding.bytes || !binding.sha256) throw new Error(`missing ${agent} binding`);
    const charter = readFileSync(binding.path);
    if (charter.length !== binding.bytes) throw new Error(`${agent} charter byte mismatch`);
    if (createHash("sha256").update(charter).digest("hex") !== binding.sha256) throw new Error(`${agent} charter hash mismatch`);
    if (statSync(binding.path).mode % 0o1000 !== 0o600) throw new Error(`${agent} charter mode mismatch`);
    const bootstrapPath = join(runDir, "launch-charters", `${agent}-bootstrap.txt`);
    const bootstrap = readFileSync(bootstrapPath, "utf8");
    if (Buffer.byteLength(bootstrap, "utf8") >= 1024) throw new Error(`${agent} bootstrap too large`);
    if (bootstrap.includes(sentinel)) throw new Error(`${agent} bootstrap leaked charter body`);
    if (!bootstrap.includes(binding.path) || !bootstrap.includes(binding.sha256) || !bootstrap.includes("fail closed")) throw new Error(`${agent} bootstrap binding mismatch`);
    if (statSync(bootstrapPath).mode % 0o1000 !== 0o600) throw new Error(`${agent} bootstrap mode mismatch`);
    if (statSync(dirname(bootstrapPath)).mode % 0o1000 !== 0o700) throw new Error("launch-charters directory mode mismatch");
  }
' "${MANIFEST_PATH}" 'BEGIN-LARGE-CHARTER'

cd "${SMOKE_ROOT}/hash-repo"
touch .git/loop-smoke-hash-gate
set +e
env "${COMMON_ENV[@]}" "LOOP_SMOKE_TMUX_SOCKET=${HASH_SMOKE_SOCKET}" \
  "HOME=${SMOKE_ROOT}/hash-home" \
  "PATH=${SMOKE_ROOT}/hash-bin:${PATH}" \
  "${LOOP_ROOT}/loop" --tmux --agent gemini --pair-with cursor \
  -p "${PROMPT_PATH}" >"${SMOKE_ROOT}/hash.out" 2>"${SMOKE_ROOT}/hash.err"
HASH_LAUNCH_STATUS=$?
set -e
if [ "${HASH_LAUNCH_STATUS}" -ne 0 ]; then
  sed -n '1,120p' "${SMOKE_ROOT}/hash.out" >&2
  sed -n '1,120p' "${SMOKE_ROOT}/hash.err" >&2
  exit "${HASH_LAUNCH_STATUS}"
fi
HASH_MANIFEST="$(find "${SMOKE_ROOT}/hash-home/.loop/runs" -name manifest.json -type f -print -quit)"
HASH_GEMINI_PANE="$(pane_for_agent "${HASH_MANIFEST}" gemini)"
for _attempt in $(seq 1 40); do
  if [ -f .git/loop-smoke-gemini.ready ]; then
    break
  fi
  sleep 0.25
done
if [ ! -f .git/loop-smoke-gemini.ready ]; then
  echo "large-prompt smoke: hash-gate agent did not receive its bootstrap" >&2
  exit 1
fi
HASH_GEMINI_CHARTER="$(bun -e 'const m=await Bun.file(process.argv[1]).json(); console.log(m.launchCharters.gemini.path)' "${HASH_MANIFEST}")"
printf '\ncontrolled-smoke-tamper\n' >>"${HASH_GEMINI_CHARTER}"
touch .git/loop-smoke-continue
HASH_OUTPUT="$(wait_for_pane_text "${HASH_SMOKE_SOCKET}" "${HASH_GEMINI_PANE}" "BOOTSTRAP_HASH_MISMATCH gemini")"
if grep -Fq "WORK_STARTED gemini" <<<"${HASH_OUTPUT}"; then
  echo "large-prompt smoke: hash mismatch did not fail closed" >&2
  exit 1
fi

set +e
env "${COMMON_ENV[@]}" "HOME=${SMOKE_ROOT}/home" \
  "PATH=${SMOKE_ROOT}/fail-bin:${PATH}" \
  "${LOOP_ROOT}/loop" --tmux --agent gemini --pair-with cursor \
  -p "${PROMPT_PATH}" >"${SMOKE_ROOT}/failure.out" 2>"${SMOKE_ROOT}/failure.err"
FAILURE_STATUS=$?
set -e
if [ "${FAILURE_STATUS}" -eq 0 ]; then
  echo "large-prompt smoke: missing workspace exited successfully" >&2
  exit 1
fi
grep -Fq 'exited before attach' "${SMOKE_ROOT}/failure.err"

echo "large-prompt smoke: session=${TMUX_SESSION} panes=${LEFT_AGENT}:${LEFT_PANE},${RIGHT_AGENT}:${RIGHT_PANE} manifest=ok bootstrap=verified hash-mismatch=fail-closed missing-workspace-exit=${FAILURE_STATUS}"
