#!/usr/bin/env bash
set -euo pipefail
exec 9>&2

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOOP_ROOT="${REPO_ROOT}/loop-fork"
SMOKE_LOOP_BINARY="${LOOP_SMOKE_BINARY:-}"
SMOKE_EXPECTED_SHA256="${LOOP_SMOKE_EXPECTED_SHA256:-}"
SMOKE_USES_PREBUILT=0
FIXTURES="${REPO_ROOT}/runs/large-prompt-launch/artifacts/fake-bin"
HASH_TUI="${REPO_ROOT}/evals/smoke/fixtures/hash-bound-tui.py"
ORIGINAL_HOME="${HOME:?large-prompt smoke requires HOME for host-isolation checks}"

if [ -n "${LOOP_SMOKE_BINARY:-}" ]; then
  SMOKE_USES_PREBUILT=1
  if [ -z "${SMOKE_EXPECTED_SHA256}" ]; then
    echo "large-prompt smoke: LOOP_SMOKE_BINARY requires LOOP_SMOKE_EXPECTED_SHA256" >&2
    exit 2
  fi
  if ! [[ "${SMOKE_EXPECTED_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "large-prompt smoke: LOOP_SMOKE_EXPECTED_SHA256 must be 64 lowercase hex characters" >&2
    exit 2
  fi
  case "${SMOKE_LOOP_BINARY}" in
    /*) ;;
    *)
      echo "large-prompt smoke: loop binary path must be absolute: ${SMOKE_LOOP_BINARY}" >&2
      exit 2
      ;;
  esac
  if [ ! -f "${SMOKE_LOOP_BINARY}" ] || [ ! -x "${SMOKE_LOOP_BINARY}" ]; then
    echo "large-prompt smoke: prebuilt loop binary is not an executable file: ${SMOKE_LOOP_BINARY}" >&2
    exit 2
  fi
elif [ -n "${SMOKE_EXPECTED_SHA256}" ]; then
  echo "large-prompt smoke: LOOP_SMOKE_EXPECTED_SHA256 requires LOOP_SMOKE_BINARY" >&2
  exit 2
fi

SMOKE_ROOT="$(mktemp -d "/tmp/loop-smoke.XXXXXX")"
SMOKE_ROOT="$(cd "${SMOKE_ROOT}" && pwd -P)"
if [ "${SMOKE_USES_PREBUILT}" -ne 1 ]; then
  SMOKE_LOOP_BINARY="${SMOKE_ROOT}/build/loop"
fi
SUCCESS_ROOT="${SMOKE_ROOT}/success"
HASH_ROOT="${SMOKE_ROOT}/hash"
FAILURE_ROOT="${SMOKE_ROOT}/failure"
INFO_ROOT="${SMOKE_ROOT}/info"
CLAUDE_READY_ROOT="${SMOKE_ROOT}/claude-ready"
CLAUDE_TIMEOUT_ROOT="${SMOKE_ROOT}/claude-timeout"
SUCCESS_HOME="${SUCCESS_ROOT}/home"
HASH_HOME="${HASH_ROOT}/home"
FAILURE_HOME="${FAILURE_ROOT}/home"
CLAUDE_READY_HOME="${CLAUDE_READY_ROOT}/home"
CLAUDE_TIMEOUT_HOME="${CLAUDE_TIMEOUT_ROOT}/home"
SUCCESS_REPO="${SUCCESS_ROOT}/repo"
HASH_REPO="${HASH_ROOT}/repo"
FAILURE_REPO="${FAILURE_ROOT}/repo"
INFO_REPO="${INFO_ROOT}/repo"
CLAUDE_READY_REPO="${CLAUDE_READY_ROOT}/repo"
CLAUDE_TIMEOUT_REPO="${CLAUDE_TIMEOUT_ROOT}/repo"
SUCCESS_BIN="${SUCCESS_ROOT}/bin"
HASH_BIN="${HASH_ROOT}/bin"
FAILURE_BIN="${FAILURE_ROOT}/bin"
INFO_BIN="${INFO_ROOT}/bin"
CLAUDE_READY_BIN="${CLAUDE_READY_ROOT}/bin"
CLAUDE_TIMEOUT_BIN="${CLAUDE_TIMEOUT_ROOT}/bin"
SUCCESS_TMUX_TMPDIR="${SUCCESS_ROOT}/tmux"
HASH_TMUX_TMPDIR="${HASH_ROOT}/tmux"
FAILURE_TMUX_TMPDIR="${FAILURE_ROOT}/tmux"
INFO_TMUX_TMPDIR="${INFO_ROOT}/tmux"
CLAUDE_READY_TMUX_TMPDIR="${CLAUDE_READY_ROOT}/tmux"
CLAUDE_TIMEOUT_TMUX_TMPDIR="${CLAUDE_TIMEOUT_ROOT}/tmux"
SMOKE_SOCKET="loop-large-prompt-$RANDOM-$$"
HASH_SMOKE_SOCKET="loop-hash-mismatch-$RANDOM-$$"
FAILURE_SMOKE_SOCKET="loop-missing-workspace-$RANDOM-$$"
INFO_SMOKE_SOCKET="loop-info-no-maintenance-$RANDOM-$$"
CLAUDE_READY_SMOKE_SOCKET="loop-claude-ready-$RANDOM-$$"
CLAUDE_TIMEOUT_SMOKE_SOCKET="loop-claude-timeout-$RANDOM-$$"
# The active-launch reservation layer allocates new runs before the later
# prepared-run path reads LOOP_RUN_ID. Every case below has a fresh isolated
# home/repository, so its first authoritative reserved run is deterministically
# `1`. LOOP_RUN_ID remains in the child environment only as a transport fixture;
# it is not a new-run selector.
SUCCESS_RUN_ID="1"
HASH_RUN_ID="1"
FAILURE_RUN_ID="1"
INFO_RUN_ID="informational-no-maintenance"
CLAUDE_READY_RUN_ID="1"
CLAUDE_TIMEOUT_RUN_ID="1"
INFO_FIXTURE_RUN_ID="abandoned-fixture"
CHARTER_SENTINEL="BEGIN-LARGE-CHARTER-$RANDOM-$$"
CHARTER_TRAILING_SENTINEL="END-LARGE-CHARTER-$RANDOM-$$"
SYSTEM_PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SMOKE_USER="$(id -un)"
SMOKE_UID="$(id -u)"
SMOKE_SHELL="/bin/sh"
SMOKE_TERM="xterm-256color"
SMOKE_LANG="C"

cleanup() {
  local status=$?
  local observed=""
  trap - EXIT
  smoke_tmux "${SUCCESS_TMUX_TMPDIR}" "${SMOKE_SOCKET}" kill-server \
    >/dev/null 2>&1 || true
  smoke_tmux "${HASH_TMUX_TMPDIR}" "${HASH_SMOKE_SOCKET}" kill-server \
    >/dev/null 2>&1 || true
  smoke_tmux "${FAILURE_TMUX_TMPDIR}" "${FAILURE_SMOKE_SOCKET}" kill-server \
    >/dev/null 2>&1 || true
  smoke_tmux "${INFO_TMUX_TMPDIR}" "${INFO_SMOKE_SOCKET}" kill-server \
    >/dev/null 2>&1 || true
  smoke_tmux \
    "${CLAUDE_READY_TMUX_TMPDIR}" \
    "${CLAUDE_READY_SMOKE_SOCKET}" \
    kill-server >/dev/null 2>&1 || true
  smoke_tmux \
    "${CLAUDE_TIMEOUT_TMUX_TMPDIR}" \
    "${CLAUDE_TIMEOUT_SMOKE_SOCKET}" \
    kill-server >/dev/null 2>&1 || true
  if [ "${SMOKE_USES_PREBUILT}" -eq 1 ]; then
    observed="$(smoke_binary_sha256 2>/dev/null || true)"
    if [ "${observed}" != "${SMOKE_EXPECTED_SHA256}" ]; then
      echo "large-prompt smoke: cleanup: prebuilt binary hash ${observed:-missing} != expected ${SMOKE_EXPECTED_SHA256}" >&2
      status=1
    fi
  fi
  if [ "${status}" -ne 0 ]; then
    for smoke_error in "${SMOKE_ROOT}"/*.err; do
      if [ -s "${smoke_error}" ]; then
        echo "large-prompt smoke: failure log ${smoke_error}" >&9
        sed -n '1,160p' "${smoke_error}" >&9
      fi
    done
  fi
  if [ "${status}" -eq 0 ] || [ "${LOOP_SMOKE_KEEP_ON_FAILURE:-0}" != "1" ]; then
    rm -rf "${SMOKE_ROOT}"
  else
    echo "large-prompt smoke: preserved failure artifacts at ${SMOKE_ROOT}" >&9
  fi
  exit "${status}"
}
trap cleanup EXIT

smoke_binary_sha256() {
  shasum -a 256 "${SMOKE_LOOP_BINARY}" | cut -d ' ' -f 1
}

assert_prebuilt_binary_unchanged() {
  local stage="$1"
  local observed
  if [ "${SMOKE_USES_PREBUILT}" -ne 1 ]; then
    return 0
  fi
  observed="$(smoke_binary_sha256)"
  if [ "${observed}" != "${SMOKE_EXPECTED_SHA256}" ]; then
    echo "large-prompt smoke: ${stage}: prebuilt binary hash ${observed} != expected ${SMOKE_EXPECTED_SHA256}" >&2
    exit 1
  fi
}

assert_tmux_socket_path_budget() {
  local tmux_tmpdir="$1"
  local socket="$2"
  local socket_path="${tmux_tmpdir}/tmux-${SMOKE_UID}/${socket}"
  if [ "${#socket_path}" -gt 103 ]; then
    echo "large-prompt smoke: tmux socket path exceeds Darwin's 103-byte pathname budget: ${socket_path}" >&2
    exit 1
  fi
}

prepare_case() {
  local root="$1"
  local update_cache="${root}/home/.cache/loop/update"
  mkdir -p \
    "${root}/bin" \
    "${root}/claude-config" \
    "${root}/codex-home" \
    "${root}/home" \
    "${update_cache}" \
    "${root}/repo" \
    "${root}/tmp" \
    "${root}/tmux" \
    "${root}/xdg-cache" \
    "${root}/xdg-config" \
    "${root}/xdg-data"
  chmod 700 \
    "${root}/claude-config" \
    "${root}/codex-home" \
    "${root}/home" \
    "${root}/home/.cache" \
    "${root}/home/.cache/loop" \
    "${update_cache}" \
    "${root}/tmp" \
    "${root}/tmux" \
    "${root}/xdg-cache" \
    "${root}/xdg-config" \
    "${root}/xdg-data"
  printf '{"lastCheck":"%s"}\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    >"${update_cache}/last-check.json"
  chmod 600 "${update_cache}/last-check.json"
  git init -q "${root}/repo"
}

make_agent_bin() {
  local target="$1"
  cp "${HASH_TUI}" "${target}/gemini"
  cp "${HASH_TUI}" "${target}/cursor"
  cp "${HASH_TUI}" "${target}/claude"
  cp "${FIXTURES}/tmux" "${target}/tmux"
  chmod +x "${target}/"*
}

run_isolated_loop() {
  local root="$1"
  local case_bin="$2"
  local socket="$3"
  local run_id="$4"
  local recon_panes=0
  local utility_pane=0
  shift 4
  if [ "${LOOP_SMOKE_FULL_LAYOUT:-0}" = "1" ]; then
    recon_panes=3
    utility_pane=1
  fi
  assert_prebuilt_binary_unchanged "before ${run_id}"
  env -i \
    "HOME=${root}/home" \
    "CLAUDE_CONFIG_DIR=${root}/claude-config" \
    "CODEX_HOME=${root}/codex-home" \
    "TMPDIR=${root}/tmp" \
    "TMUX_TMPDIR=${root}/tmux" \
    "XDG_CACHE_HOME=${root}/xdg-cache" \
    "XDG_CONFIG_HOME=${root}/xdg-config" \
    "XDG_DATA_HOME=${root}/xdg-data" \
    "PATH=${case_bin}:${SYSTEM_PATH}" \
    "USER=${SMOKE_USER}" \
    "LOGNAME=${SMOKE_USER}" \
    "SHELL=${SMOKE_SHELL}" \
    "TERM=${SMOKE_TERM}" \
    "LANG=${SMOKE_LANG}" \
    "LOOP_RUN_ID=${run_id}" \
    "LOOP_SMOKE_CLAUDE_STARTUP=${LOOP_SMOKE_CLAUDE_STARTUP:-}" \
    "LOOP_SMOKE_TRACE_PATH=${root}/trace.log" \
    LOOP_AU_PAIR_ENABLED=0 \
    LOOP_NANNY_ENABLED=0 \
    "LOOP_RECON_PANES=${recon_panes}" \
    "LOOP_SMOKE_TMUX_SOCKET=${socket}" \
    "LOOP_UTILITY_PANE=${utility_pane}" \
    "${SMOKE_LOOP_BINARY}" "$@"
}

smoke_tmux() {
  local tmux_tmpdir="$1"
  local socket="$2"
  local root
  shift 2
  root="$(dirname "${tmux_tmpdir}")"
  env -i \
    "HOME=${root}/home" \
    "PATH=${SYSTEM_PATH}" \
    "USER=${SMOKE_USER}" \
    "LOGNAME=${SMOKE_USER}" \
    "SHELL=${SMOKE_SHELL}" \
    "TERM=${SMOKE_TERM}" \
    "LANG=${SMOKE_LANG}" \
    "TMUX_TMPDIR=${tmux_tmpdir}" \
    /opt/homebrew/bin/tmux -L "${socket}" "$@"
}

expected_repo_id() {
  local repo="$1"
  local common_dir
  local label
  local sanitized
  local digest
  common_dir="$(git -C "${repo}" rev-parse --path-format=absolute --git-common-dir)"
  common_dir="$(cd "${common_dir}" && pwd -P)"
  label="$(basename "$(dirname "${common_dir}")")"
  sanitized="$(
    printf '%s' "${label}" |
      tr '[:upper:]' '[:lower:]' |
      sed -E 's/[^a-z0-9-]+/-/g; s/^-+//; s/-+$//'
  )"
  if [ -z "${sanitized}" ]; then
    sanitized="loop"
  fi
  digest="$(printf '%s' "${common_dir}" | shasum -a 256 | cut -c1-12)"
  printf '%s-%s\n' "${sanitized}" "${digest}"
}

assert_host_isolation() {
  local repo_id="$1"
  local run_id="$2"
  local stage="$3"
  local host_repo_root="${ORIGINAL_HOME}/.loop/runs/${repo_id}"
  local host_run_dir="${host_repo_root}/${run_id}"
  local leaked_file=""
  if [ -e "${host_run_dir}" ] || [ -L "${host_run_dir}" ]; then
    echo "large-prompt smoke: ${stage}: isolated run bound host path ${host_run_dir}" >&2
    exit 1
  fi
  if [ -d "${host_repo_root}" ]; then
    leaked_file="$(
      grep -R -F -l -- "${CHARTER_SENTINEL}" "${host_repo_root}" \
        2>/dev/null | head -1 || true
    )"
  fi
  if [ -n "${leaked_file}" ]; then
    echo "large-prompt smoke: ${stage}: charter sentinel leaked into host storage at ${leaked_file}" >&2
    exit 1
  fi
}

manifest_field() {
  bun -e 'const m=await Bun.file(process.argv[1]).json(); console.log(m[process.argv[2]] ?? "")' "$1" "$2"
}

assert_manifest_binding() {
  local manifest_path="$1"
  local case_home="$2"
  local case_repo="$3"
  local repo_id="$4"
  local run_id="$5"
  local expected_path="${case_home}/.loop/runs/${repo_id}/${run_id}/manifest.json"
  if [ "${manifest_path}" != "${expected_path}" ] || [ ! -f "${expected_path}" ]; then
    echo "large-prompt smoke: manifest did not bind exact isolated path ${expected_path}" >&2
    exit 1
  fi
  bun -e '
    import { readFileSync, realpathSync } from "node:fs";
    import { isAbsolute, join, relative, resolve, sep } from "node:path";
    const [manifestPath, caseHome, caseRepo, repoId, runId, promptPath, sentinel] = process.argv.slice(1);
    const runDir = join(caseHome, ".loop", "runs", repoId, runId);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const sourcePrompt = readFileSync(promptPath);
    if (sourcePrompt.length < 8192) throw new Error(`source prompt too small: ${sourcePrompt.length}`);
    if (resolve(manifestPath) !== resolve(join(runDir, "manifest.json"))) throw new Error("manifest path escaped isolated run");
    if (realpathSync(manifest.cwd) !== realpathSync(caseRepo)) throw new Error(`manifest cwd mismatch: ${manifest.cwd}`);
    if (manifest.repoId !== repoId) throw new Error(`manifest repoId mismatch: ${manifest.repoId}`);
    if (manifest.runId !== runId) throw new Error(`manifest runId mismatch: ${manifest.runId}`);
    const realRunDir = realpathSync(runDir);
    const mappedAgents = [manifest.tmuxPaneLeftAgent, manifest.tmuxPaneRightAgent];
    const agents = mappedAgents.every((agent) => typeof agent === "string" && agent)
      ? mappedAgents
      : Object.keys(manifest.launchCharters ?? {});
    if (agents.length !== 2) throw new Error("missing paired launch-charter binding");
    for (const agent of agents) {
      const binding = manifest.launchCharters?.[agent];
      if (!binding?.path) throw new Error(`missing ${agent} launch charter`);
      const charterPath = realpathSync(binding.path);
      const runRelative = relative(realRunDir, charterPath);
      if (!runRelative || isAbsolute(runRelative) || runRelative === ".." || runRelative.startsWith(`..${sep}`)) {
        throw new Error(`${agent} launch charter escaped isolated run`);
      }
      const charter = readFileSync(charterPath);
      if (!charter.toString("utf8").includes(sentinel)) throw new Error(`${agent} charter omitted randomized sentinel`);
      if (charter.indexOf(sourcePrompt) === -1) throw new Error(`${agent} charter omitted or truncated source prompt`);
    }
  ' "${manifest_path}" "${case_home}" "${case_repo}" "${repo_id}" "${run_id}" "${PROMPT_PATH}" "${CHARTER_SENTINEL}"
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
  local tmux_tmpdir="$1"
  local socket="$2"
  local pane="$3"
  local text="$4"
  local output=""
  for _attempt in $(seq 1 40); do
    output="$(smoke_tmux "${tmux_tmpdir}" "${socket}" capture-pane -p -J -S -200 -t "${pane}")"
    if grep -Fq "${text}" <<<"${output}"; then
      printf '%s' "${output}"
      return 0
    fi
    sleep 0.25
  done
  printf '%s\n' "${output}" >&2
  return 1
}

assert_trace_order() {
  local trace_path="$1"
  local previous=0
  local line=0
  shift
  for marker in "$@"; do
    line="$(grep -n -F -m 1 -- "${marker}" "${trace_path}" | cut -d: -f1 || true)"
    if [ -z "${line}" ] || [ "${line}" -le "${previous}" ]; then
      echo "large-prompt smoke: trace marker missing or out of order: ${marker}" >&2
      sed -n '1,120p' "${trace_path}" >&2 || true
      exit 1
    fi
    previous="${line}"
  done
}

assert_full_layout_geometry() {
  local manifest_path="$1"
  local tmux_tmpdir="$2"
  local socket="$3"
  local session
  local geometry
  local clients
  local panes_path="${SMOKE_ROOT}/claude-ready-panes.tsv"
  session="$(manifest_field "${manifest_path}" tmuxSession)"
  geometry="$(
    smoke_tmux \
      "${tmux_tmpdir}" \
      "${socket}" \
      display-message -p -t "${session}:0" '#{window_width}x#{window_height}'
  )"
  if [ "${geometry}" != "220x60" ]; then
    echo "large-prompt smoke: detached paired geometry was ${geometry}, expected 220x60" >&2
    exit 1
  fi
  clients="$(
    smoke_tmux "${tmux_tmpdir}" "${socket}" list-clients -F '#{client_session}' \
      2>/dev/null || true
  )"
  if grep -Fqx "${session}" <<<"${clients}"; then
    echo "large-prompt smoke: detached geometry session unexpectedly had a client" >&2
    exit 1
  fi
  smoke_tmux \
    "${tmux_tmpdir}" \
    "${socket}" \
    list-panes -t "${session}" \
    -F '#{pane_id}|#{pane_width}|#{pane_height}' >"${panes_path}"
  if ! bun -e '
    import { readFileSync } from "node:fs";
    const [manifestPath, panesPath] = process.argv.slice(1);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const panes = new Map(
      readFileSync(panesPath, "utf8").trim().split("\n").filter(Boolean).map((line) => {
        const [id, width, height] = line.split("|");
        return [id, { width: Number(width), height: Number(height) }];
      })
    );
    if (panes.size !== 6) throw new Error(`expected 6 panes, found ${panes.size}`);
    const assertFloor = (label, pane, width, height) => {
      const actual = panes.get(pane);
      if (!actual) throw new Error(`${label} pane ${pane || "missing"} is not live`);
      if (actual.width < width || actual.height < height) {
        throw new Error(`${label} pane ${pane} is ${actual.width}x${actual.height}, below ${width}x${height}`);
      }
    };
    assertFloor("left agent", manifest.tmuxPaneLeft, 100, 24);
    assertFloor("right agent", manifest.tmuxPaneRight, 100, 24);
    assertFloor("Governess", manifest.tmuxPaneGoverness, 160, 18);
    assertFloor("Nanny", manifest.tmuxPaneNanny, 40, 8);
    assertFloor("Au Pair", manifest.tmuxPaneAuPair, 40, 8);
    if (!Array.isArray(manifest.tmuxPaneRecon) || manifest.tmuxPaneRecon.length !== 1) {
      throw new Error("manifest does not bind the consolidated Activity pane");
    }
    assertFloor("Activity", manifest.tmuxPaneRecon[0], 200, 8);
  ' "${manifest_path}" "${panes_path}"; then
    return 1
  fi
  printf '%s' "${geometry}"
}

assert_tmux_socket_path_budget "${SUCCESS_TMUX_TMPDIR}" "${SMOKE_SOCKET}"
assert_tmux_socket_path_budget "${HASH_TMUX_TMPDIR}" "${HASH_SMOKE_SOCKET}"
assert_tmux_socket_path_budget "${FAILURE_TMUX_TMPDIR}" "${FAILURE_SMOKE_SOCKET}"
assert_tmux_socket_path_budget "${INFO_TMUX_TMPDIR}" "${INFO_SMOKE_SOCKET}"
assert_tmux_socket_path_budget \
  "${CLAUDE_READY_TMUX_TMPDIR}" \
  "${CLAUDE_READY_SMOKE_SOCKET}"
assert_tmux_socket_path_budget \
  "${CLAUDE_TIMEOUT_TMUX_TMPDIR}" \
  "${CLAUDE_TIMEOUT_SMOKE_SOCKET}"

cd "${LOOP_ROOT}"
assert_prebuilt_binary_unchanged "before launch"
bun run test:file -- -t \
  'transports a realistic charter through hash-bound pointer bootstraps' \
  tests/loop/tmux.test.ts
if [ "${SMOKE_USES_PREBUILT}" -ne 1 ]; then
  mkdir -p "$(dirname "${SMOKE_LOOP_BINARY}")"
  bun build --compile --outfile "${SMOKE_LOOP_BINARY}" src/cli.ts >/dev/null
fi

prepare_case "${SUCCESS_ROOT}"
prepare_case "${HASH_ROOT}"
prepare_case "${FAILURE_ROOT}"
prepare_case "${INFO_ROOT}"
prepare_case "${CLAUDE_READY_ROOT}"
prepare_case "${CLAUDE_TIMEOUT_ROOT}"
make_agent_bin "${SUCCESS_BIN}"
make_agent_bin "${INFO_BIN}"
make_agent_bin "${CLAUDE_READY_BIN}"
make_agent_bin "${CLAUDE_TIMEOUT_BIN}"
cp "${HASH_TUI}" "${HASH_BIN}/gemini"
cp "${FIXTURES}/cursor" "${HASH_BIN}/cursor"
cp "${FIXTURES}/tmux" "${HASH_BIN}/tmux"
cp "${HASH_TUI}" "${FAILURE_BIN}/gemini"
cp "${HASH_TUI}" "${FAILURE_BIN}/cursor"
cp "${FIXTURES}/tmux-no-session" "${FAILURE_BIN}/tmux"
chmod +x "${HASH_BIN}/"* "${FAILURE_BIN}/"*
PROMPT_PATH="${SMOKE_ROOT}/charter.md"
{
  printf '%s\n' "${CHARTER_SENTINEL}"
  awk 'BEGIN { for (i = 0; i < 10257; i++) printf "x" }'
  printf '\n%s\n' "${CHARTER_TRAILING_SENTINEL}"
} >"${PROMPT_PATH}"

SUCCESS_REPO_ID="$(expected_repo_id "${SUCCESS_REPO}")"
HASH_REPO_ID="$(expected_repo_id "${HASH_REPO}")"
FAILURE_REPO_ID="$(expected_repo_id "${FAILURE_REPO}")"
INFO_REPO_ID="$(expected_repo_id "${INFO_REPO}")"
CLAUDE_READY_REPO_ID="$(expected_repo_id "${CLAUDE_READY_REPO}")"
CLAUDE_TIMEOUT_REPO_ID="$(expected_repo_id "${CLAUDE_TIMEOUT_REPO}")"
SUCCESS_MANIFEST="${SUCCESS_HOME}/.loop/runs/${SUCCESS_REPO_ID}/${SUCCESS_RUN_ID}/manifest.json"
HASH_MANIFEST="${HASH_HOME}/.loop/runs/${HASH_REPO_ID}/${HASH_RUN_ID}/manifest.json"
FAILURE_MANIFEST="${FAILURE_HOME}/.loop/runs/${FAILURE_REPO_ID}/${FAILURE_RUN_ID}/manifest.json"
INFO_FIXTURE_DIR="${INFO_ROOT}/home/.loop/runs/${INFO_REPO_ID}/${INFO_FIXTURE_RUN_ID}"
INFO_FIXTURE_MANIFEST="${INFO_FIXTURE_DIR}/manifest.json"
CLAUDE_READY_MANIFEST="${CLAUDE_READY_HOME}/.loop/runs/${CLAUDE_READY_REPO_ID}/${CLAUDE_READY_RUN_ID}/manifest.json"
CLAUDE_TIMEOUT_MANIFEST="${CLAUDE_TIMEOUT_HOME}/.loop/runs/${CLAUDE_TIMEOUT_REPO_ID}/${CLAUDE_TIMEOUT_RUN_ID}/manifest.json"

assert_host_isolation "${SUCCESS_REPO_ID}" "${SUCCESS_RUN_ID}" "before success launch"
assert_host_isolation "${HASH_REPO_ID}" "${HASH_RUN_ID}" "before hash launch"
assert_host_isolation "${FAILURE_REPO_ID}" "${FAILURE_RUN_ID}" "before failure launch"
assert_host_isolation "${INFO_REPO_ID}" "${INFO_FIXTURE_RUN_ID}" "before information command"
assert_host_isolation \
  "${CLAUDE_READY_REPO_ID}" \
  "${CLAUDE_READY_RUN_ID}" \
  "before delayed-Claude launch"
assert_host_isolation \
  "${CLAUDE_TIMEOUT_REPO_ID}" \
  "${CLAUDE_TIMEOUT_RUN_ID}" \
  "before never-ready Claude launch"

mkdir -p "${INFO_FIXTURE_DIR}"
bun -e '
  const [path, repoId, runId, cwd] = process.argv.slice(1);
  const now = "2026-07-30T00:00:00.000Z";
  await Bun.write(path, `${JSON.stringify({
    claudeSessionId: "",
    codexThreadId: "",
    createdAt: now,
    cwd,
    mode: "tmux",
    pid: 999999,
    repoId,
    runId,
    state: "submitted",
    status: "running",
    tmuxSession: "definitely-not-a-live-session",
    updatedAt: now,
  }, null, 2)}\n`);
' "${INFO_FIXTURE_MANIFEST}" "${INFO_REPO_ID}" "${INFO_FIXTURE_RUN_ID}" "${INFO_REPO}"
INFO_MANIFEST_HASH_BEFORE="$(shasum -a 256 "${INFO_FIXTURE_MANIFEST}" | cut -d ' ' -f 1)"

cd "${INFO_REPO}"
run_isolated_loop \
  "${INFO_ROOT}" \
  "${INFO_BIN}" \
  "${INFO_SMOKE_SOCKET}" \
  "${INFO_RUN_ID}" \
  collab --help >"${SMOKE_ROOT}/info.out" 2>"${SMOKE_ROOT}/info.err"
grep -Fq 'Usage:' "${SMOKE_ROOT}/info.out"
INFO_MANIFEST_HASH_AFTER="$(shasum -a 256 "${INFO_FIXTURE_MANIFEST}" | cut -d ' ' -f 1)"
if [ "${INFO_MANIFEST_HASH_AFTER}" != "${INFO_MANIFEST_HASH_BEFORE}" ]; then
  echo "large-prompt smoke: nested help mutated the hostile run fixture" >&2
  exit 1
fi
assert_host_isolation "${INFO_REPO_ID}" "${INFO_FIXTURE_RUN_ID}" "after information command"

cd "${SUCCESS_REPO}"
run_isolated_loop \
  "${SUCCESS_ROOT}" \
  "${SUCCESS_BIN}" \
  "${SMOKE_SOCKET}" \
  "${SUCCESS_RUN_ID}" \
  --tmux --agent gemini --pair-with cursor \
  -p "${PROMPT_PATH}" >"${SMOKE_ROOT}/success.out" 2>"${SMOKE_ROOT}/success.err"

assert_manifest_binding \
  "${SUCCESS_MANIFEST}" \
  "${SUCCESS_HOME}" \
  "${SUCCESS_REPO}" \
  "${SUCCESS_REPO_ID}" \
  "${SUCCESS_RUN_ID}"
assert_host_isolation "${SUCCESS_REPO_ID}" "${SUCCESS_RUN_ID}" "after success launch"

TMUX_SESSION="$(manifest_field "${SUCCESS_MANIFEST}" tmuxSession)"
LEFT_PANE="$(manifest_field "${SUCCESS_MANIFEST}" tmuxPaneLeft)"
RIGHT_PANE="$(manifest_field "${SUCCESS_MANIFEST}" tmuxPaneRight)"
LEFT_AGENT="$(manifest_field "${SUCCESS_MANIFEST}" tmuxPaneLeftAgent)"
RIGHT_AGENT="$(manifest_field "${SUCCESS_MANIFEST}" tmuxPaneRightAgent)"
if [ -z "${TMUX_SESSION}" ]; then
  echo "large-prompt smoke: manifest tmuxSession is empty" >&2
  exit 1
fi
if [ "${LEFT_AGENT}" != "gemini" ] || [ "${RIGHT_AGENT}" != "cursor" ]; then
  echo "large-prompt smoke: unexpected agent pane mapping" >&2
  exit 1
fi
smoke_tmux "${SUCCESS_TMUX_TMPDIR}" "${SMOKE_SOCKET}" has-session -t "${TMUX_SESSION}"
LIVE_PANES="$(
  smoke_tmux \
    "${SUCCESS_TMUX_TMPDIR}" \
    "${SMOKE_SOCKET}" \
    list-panes -t "${TMUX_SESSION}" -F '#{pane_id}'
)"
grep -Fqx "${LEFT_PANE}" <<<"${LIVE_PANES}"
grep -Fqx "${RIGHT_PANE}" <<<"${LIVE_PANES}"
wait_for_pane_text \
  "${SUCCESS_TMUX_TMPDIR}" \
  "${SMOKE_SOCKET}" \
  "${LEFT_PANE}" \
  "BOOTSTRAP_VERIFIED gemini" >/dev/null
wait_for_pane_text \
  "${SUCCESS_TMUX_TMPDIR}" \
  "${SMOKE_SOCKET}" \
  "${RIGHT_PANE}" \
  "BOOTSTRAP_VERIFIED cursor" >/dev/null

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
' "${SUCCESS_MANIFEST}" "${CHARTER_SENTINEL}"

cd "${CLAUDE_READY_REPO}"
LOOP_SMOKE_CLAUDE_STARTUP=delayed-dev \
LOOP_SMOKE_FULL_LAYOUT=1 \
run_isolated_loop \
  "${CLAUDE_READY_ROOT}" \
  "${CLAUDE_READY_BIN}" \
  "${CLAUDE_READY_SMOKE_SOCKET}" \
  "${CLAUDE_READY_RUN_ID}" \
  --tmux --agent gemini --pair-with claude \
  --governess --governess-dry-run \
  -p "${PROMPT_PATH}" \
  >"${SMOKE_ROOT}/claude-ready.out" \
  2>"${SMOKE_ROOT}/claude-ready.err"
assert_manifest_binding \
  "${CLAUDE_READY_MANIFEST}" \
  "${CLAUDE_READY_HOME}" \
  "${CLAUDE_READY_REPO}" \
  "${CLAUDE_READY_REPO_ID}" \
  "${CLAUDE_READY_RUN_ID}"
assert_host_isolation \
  "${CLAUDE_READY_REPO_ID}" \
  "${CLAUDE_READY_RUN_ID}" \
  "after delayed-Claude launch"
CLAUDE_READY_PANE="$(pane_for_agent "${CLAUDE_READY_MANIFEST}" claude)"
wait_for_pane_text \
  "${CLAUDE_READY_TMUX_TMPDIR}" \
  "${CLAUDE_READY_SMOKE_SOCKET}" \
  "${CLAUDE_READY_PANE}" \
  "BOOTSTRAP_VERIFIED claude" >/dev/null
assert_trace_order \
  "${CLAUDE_READY_ROOT}/trace.log" \
  $'claude\tCLAUDE_STARTUP_WARNING' \
  $'claude\tCLAUDE_DEV_CHANNEL_PROMPT' \
  $'claude\tCLAUDE_DEV_CHANNEL_CONFIRMED' \
  $'claude\tREADY claude' \
  $'claude\tBOOTSTRAP_VERIFIED claude' \
  $'claude\tWORK_STARTED claude'
if [ "$(grep -F -c $'claude\tCLAUDE_DEV_CHANNEL_CONFIRMED' "${CLAUDE_READY_ROOT}/trace.log")" -ne 1 ]; then
  echo "large-prompt smoke: Claude development-channel confirmation was not single-shot" >&2
  exit 1
fi
CLAUDE_READY_GEOMETRY="$(
  assert_full_layout_geometry \
    "${CLAUDE_READY_MANIFEST}" \
    "${CLAUDE_READY_TMUX_TMPDIR}" \
    "${CLAUDE_READY_SMOKE_SOCKET}"
)"

cd "${CLAUDE_TIMEOUT_REPO}"
set +e
LOOP_SMOKE_CLAUDE_STARTUP=never-ready \
LOOP_SMOKE_FULL_LAYOUT=1 \
run_isolated_loop \
  "${CLAUDE_TIMEOUT_ROOT}" \
  "${CLAUDE_TIMEOUT_BIN}" \
  "${CLAUDE_TIMEOUT_SMOKE_SOCKET}" \
  "${CLAUDE_TIMEOUT_RUN_ID}" \
  --tmux --agent gemini --pair-with claude \
  --governess --governess-dry-run \
  -p "${PROMPT_PATH}" \
  >"${SMOKE_ROOT}/claude-timeout.out" \
  2>"${SMOKE_ROOT}/claude-timeout.err"
CLAUDE_TIMEOUT_STATUS=$?
set -e
if [ "${CLAUDE_TIMEOUT_STATUS}" -eq 0 ]; then
  echo "large-prompt smoke: never-ready Claude launch exited successfully" >&2
  exit 1
fi
grep -Fq \
  'did not reach an input-ready prompt within 20000ms' \
  "${SMOKE_ROOT}/claude-timeout.err"
assert_manifest_binding \
  "${CLAUDE_TIMEOUT_MANIFEST}" \
  "${CLAUDE_TIMEOUT_HOME}" \
  "${CLAUDE_TIMEOUT_REPO}" \
  "${CLAUDE_TIMEOUT_REPO_ID}" \
  "${CLAUDE_TIMEOUT_RUN_ID}"
CLAUDE_TIMEOUT_STATE="$(manifest_field "${CLAUDE_TIMEOUT_MANIFEST}" state)"
CLAUDE_TIMEOUT_MANIFEST_STATUS="$(manifest_field "${CLAUDE_TIMEOUT_MANIFEST}" status)"
CLAUDE_TIMEOUT_SESSION="$(manifest_field "${CLAUDE_TIMEOUT_MANIFEST}" tmuxSession)"
if [ "${CLAUDE_TIMEOUT_STATE}" != "input-required" ] || \
  [ "${CLAUDE_TIMEOUT_MANIFEST_STATUS}" != "running" ]; then
  echo "large-prompt smoke: never-ready Claude left manifest ${CLAUDE_TIMEOUT_STATE}/${CLAUDE_TIMEOUT_MANIFEST_STATUS}" >&2
  exit 1
fi
if [ -z "${CLAUDE_TIMEOUT_SESSION}" ]; then
  echo "large-prompt smoke: never-ready Claude omitted the preserved tmux session" >&2
  exit 1
fi
grep -Fq \
  "The live tmux session \"${CLAUDE_TIMEOUT_SESSION}\" was preserved; attach with: tmux attach -t ${CLAUDE_TIMEOUT_SESSION}" \
  "${SMOKE_ROOT}/claude-timeout.err"
if grep -Fq '[loop] started tmux session' \
  "${SMOKE_ROOT}/claude-timeout.out" \
  "${SMOKE_ROOT}/claude-timeout.err"; then
  echo "large-prompt smoke: never-ready Claude launch reported false success" >&2
  exit 1
fi
if ! smoke_tmux \
  "${CLAUDE_TIMEOUT_TMUX_TMPDIR}" \
  "${CLAUDE_TIMEOUT_SMOKE_SOCKET}" \
  has-session -t "${CLAUDE_TIMEOUT_SESSION}"; then
  echo "large-prompt smoke: never-ready Claude did not preserve its tmux session" >&2
  exit 1
fi
CLAUDE_TIMEOUT_PANES="${SMOKE_ROOT}/claude-timeout-panes.tsv"
smoke_tmux \
  "${CLAUDE_TIMEOUT_TMUX_TMPDIR}" \
  "${CLAUDE_TIMEOUT_SMOKE_SOCKET}" \
  list-panes -t "${CLAUDE_TIMEOUT_SESSION}" \
  -F '#{pane_id}|#{pane_dead}|#{pane_current_command}' \
  >"${CLAUDE_TIMEOUT_PANES}"
bun -e '
  import { readFileSync } from "node:fs";
  const [manifestPath, panesPath] = process.argv.slice(1);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const panes = readFileSync(panesPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, dead] = line.split("|");
      return { dead, id };
    });
  const paneIds = panes.map(({ id }) => id);
  const left = manifest.tmuxPaneLeft;
  const right = manifest.tmuxPaneRight;
  if (!(left && right) || left === right) throw new Error("missing distinct paired recovery targets");
  const mappedAgents = [manifest.tmuxPaneLeftAgent, manifest.tmuxPaneRightAgent].sort();
  if (JSON.stringify(mappedAgents) !== JSON.stringify(["claude", "gemini"])) {
    throw new Error(`unexpected timeout agent mapping ${mappedAgents.join("/")}`);
  }
  if (paneIds.length !== 2 || !paneIds.includes(left) || !paneIds.includes(right)) {
    throw new Error(`preserved pane mismatch ${JSON.stringify(paneIds)} != ${left}/${right}`);
  }
  if (panes.some(({ dead }) => dead !== "0")) {
    throw new Error(`preserved pane was dead ${JSON.stringify(panes)}`);
  }
  if (manifest.tmuxPaneGoverness || manifest.tmuxPaneAuPair || manifest.tmuxPaneNanny || manifest.tmuxPaneUtility) {
    throw new Error("control pane started before Claude readiness");
  }
  if (Array.isArray(manifest.tmuxPaneRecon) && manifest.tmuxPaneRecon.length > 0) {
    throw new Error("recon panes started before Claude readiness");
  }
' "${CLAUDE_TIMEOUT_MANIFEST}" "${CLAUDE_TIMEOUT_PANES}"
grep -Fq $'claude\tCLAUDE_STARTUP_WARNING' "${CLAUDE_TIMEOUT_ROOT}/trace.log"
if grep -Fq $'claude\tREADY claude' "${CLAUDE_TIMEOUT_ROOT}/trace.log"; then
  echo "large-prompt smoke: never-ready Claude reported ready" >&2
  exit 1
fi
if grep -E -q $'^(claude|gemini)\t(BOOTSTRAP_VERIFIED|WORK_STARTED)' \
  "${CLAUDE_TIMEOUT_ROOT}/trace.log"; then
  echo "large-prompt smoke: never-ready Claude received work" >&2
  exit 1
fi
smoke_tmux \
  "${CLAUDE_TIMEOUT_TMUX_TMPDIR}" \
  "${CLAUDE_TIMEOUT_SMOKE_SOCKET}" \
  kill-session -t "${CLAUDE_TIMEOUT_SESSION}"
if smoke_tmux \
  "${CLAUDE_TIMEOUT_TMUX_TMPDIR}" \
  "${CLAUDE_TIMEOUT_SMOKE_SOCKET}" \
  has-session -t "${CLAUDE_TIMEOUT_SESSION}" 2>/dev/null; then
  echo "large-prompt smoke: preserved timeout session survived explicit test cleanup" >&2
  exit 1
fi
smoke_tmux \
  "${CLAUDE_TIMEOUT_TMUX_TMPDIR}" \
  "${CLAUDE_TIMEOUT_SMOKE_SOCKET}" \
  kill-server >/dev/null 2>&1 || true
assert_host_isolation \
  "${CLAUDE_TIMEOUT_REPO_ID}" \
  "${CLAUDE_TIMEOUT_RUN_ID}" \
  "after never-ready Claude launch"

cd "${HASH_REPO}"
touch .git/loop-smoke-hash-gate
set +e
run_isolated_loop \
  "${HASH_ROOT}" \
  "${HASH_BIN}" \
  "${HASH_SMOKE_SOCKET}" \
  "${HASH_RUN_ID}" \
  --tmux --agent gemini --pair-with cursor \
  -p "${PROMPT_PATH}" >"${SMOKE_ROOT}/hash.out" 2>"${SMOKE_ROOT}/hash.err"
HASH_LAUNCH_STATUS=$?
set -e
if [ "${HASH_LAUNCH_STATUS}" -ne 0 ]; then
  sed -n '1,120p' "${SMOKE_ROOT}/hash.out" >&2
  sed -n '1,120p' "${SMOKE_ROOT}/hash.err" >&2
  exit "${HASH_LAUNCH_STATUS}"
fi
assert_manifest_binding \
  "${HASH_MANIFEST}" \
  "${HASH_HOME}" \
  "${HASH_REPO}" \
  "${HASH_REPO_ID}" \
  "${HASH_RUN_ID}"
assert_host_isolation "${HASH_REPO_ID}" "${HASH_RUN_ID}" "after hash launch"
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
HASH_OUTPUT="$(
  wait_for_pane_text \
    "${HASH_TMUX_TMPDIR}" \
    "${HASH_SMOKE_SOCKET}" \
    "${HASH_GEMINI_PANE}" \
    "BOOTSTRAP_HASH_MISMATCH gemini"
)"
if grep -Fq "WORK_STARTED gemini" <<<"${HASH_OUTPUT}"; then
  echo "large-prompt smoke: hash mismatch did not fail closed" >&2
  exit 1
fi

cd "${FAILURE_REPO}"
set +e
run_isolated_loop \
  "${FAILURE_ROOT}" \
  "${FAILURE_BIN}" \
  "${FAILURE_SMOKE_SOCKET}" \
  "${FAILURE_RUN_ID}" \
  --tmux --agent gemini --pair-with cursor \
  -p "${PROMPT_PATH}" >"${SMOKE_ROOT}/failure.out" 2>"${SMOKE_ROOT}/failure.err"
FAILURE_STATUS=$?
set -e
if [ "${FAILURE_STATUS}" -eq 0 ]; then
  echo "large-prompt smoke: missing workspace exited successfully" >&2
  exit 1
fi
grep -Fq 'exited before attach' "${SMOKE_ROOT}/failure.err"
assert_manifest_binding \
  "${FAILURE_MANIFEST}" \
  "${FAILURE_HOME}" \
  "${FAILURE_REPO}" \
  "${FAILURE_REPO_ID}" \
  "${FAILURE_RUN_ID}"
FAILURE_MANIFEST_STATE="$(manifest_field "${FAILURE_MANIFEST}" state)"
FAILURE_MANIFEST_STATUS="$(manifest_field "${FAILURE_MANIFEST}" status)"
if [ "${FAILURE_MANIFEST_STATE}" != "failed" ] || \
  [ "${FAILURE_MANIFEST_STATUS}" != "failed" ]; then
  echo "large-prompt smoke: missing workspace left manifest ${FAILURE_MANIFEST_STATE}/${FAILURE_MANIFEST_STATUS}" >&2
  exit 1
fi
assert_host_isolation "${FAILURE_REPO_ID}" "${FAILURE_RUN_ID}" "after failure launch"
assert_host_isolation "${SUCCESS_REPO_ID}" "${SUCCESS_RUN_ID}" "at smoke completion"
assert_host_isolation "${HASH_REPO_ID}" "${HASH_RUN_ID}" "at smoke completion"
assert_host_isolation "${INFO_REPO_ID}" "${INFO_FIXTURE_RUN_ID}" "at smoke completion"
assert_host_isolation \
  "${CLAUDE_READY_REPO_ID}" \
  "${CLAUDE_READY_RUN_ID}" \
  "at smoke completion"
assert_host_isolation \
  "${CLAUDE_TIMEOUT_REPO_ID}" \
  "${CLAUDE_TIMEOUT_RUN_ID}" \
  "at smoke completion"
assert_prebuilt_binary_unchanged "after launch"

echo "large-prompt smoke: binary=${SMOKE_LOOP_BINARY} binary-sha256=$(smoke_binary_sha256) prebuilt=${SMOKE_USES_PREBUILT} info-fixture=unchanged session=${TMUX_SESSION} panes=${LEFT_AGENT}:${LEFT_PANE},${RIGHT_AGENT}:${RIGHT_PANE} manifest=isolated bootstrap=verified claude-delayed-ready=verified claude-timeout-exit=${CLAUDE_TIMEOUT_STATUS} claude-timeout-manifest=input-required/running claude-timeout-session=preserved-then-cleaned detached-layout=${CLAUDE_READY_GEOMETRY}/6panes activity=verified hash-mismatch=fail-closed missing-workspace-exit=${FAILURE_STATUS} missing-workspace-manifest=failed"
