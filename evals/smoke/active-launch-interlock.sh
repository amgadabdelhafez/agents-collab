#!/usr/bin/env bash
set -euo pipefail
exec 9>&2

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOOP_ROOT="${REPO_ROOT}/loop-fork"
HASH_TUI="${REPO_ROOT}/evals/smoke/fixtures/hash-bound-tui.py"
TMUX_WRAPPER="${REPO_ROOT}/evals/smoke/fixtures/isolated-tmux.sh"
SMOKE_LOOP_BINARY="${LOOP_SMOKE_BINARY:-}"
SMOKE_EXPECTED_SHA256="${LOOP_SMOKE_EXPECTED_SHA256:-}"
SMOKE_USES_PREBUILT=0
REAL_TMUX="${LOOP_SMOKE_REAL_TMUX:-$(command -v tmux)}"
SYSTEM_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SMOKE_USER="$(id -un)"
SMOKE_ROOT="$(mktemp -d /tmp/loop-launch-interlock.XXXXXX)"
SMOKE_ROOT="$(cd "${SMOKE_ROOT}" && pwd -P)"
SMOKE_HOME="${SMOKE_ROOT}/home"
SMOKE_BIN="${SMOKE_ROOT}/bin"
SMOKE_REPO="${SMOKE_ROOT}/repo"
WORKSPACE_ONE="${SMOKE_ROOT}/workspace-one"
WORKSPACE_TWO="${SMOKE_ROOT}/workspace-two"
SMOKE_TMUX_TMPDIR="${SMOKE_ROOT}/tmux"
SMOKE_SOCKET="${SMOKE_ROOT}/tmux.sock"
PROMPT_PATH="${SMOKE_ROOT}/charter.md"
START_GATE="${SMOKE_ROOT}/start-gate"
RESUME_GATE="${SMOKE_ROOT}/resume-gate"
FIRST_PID=""
SECOND_PID=""
RESUME_FIRST_PID=""
RESUME_SECOND_PID=""
DISTINCT_PID=""

if [ -n "${SMOKE_LOOP_BINARY}" ]; then
  SMOKE_USES_PREBUILT=1
  case "${SMOKE_LOOP_BINARY}" in
    /*) ;;
    *)
      echo "active-launch smoke: LOOP_SMOKE_BINARY must be absolute" >&2
      exit 2
      ;;
  esac
  if [ ! -x "${SMOKE_LOOP_BINARY}" ]; then
    echo "active-launch smoke: binary is not executable: ${SMOKE_LOOP_BINARY}" >&2
    exit 2
  fi
  if ! [[ "${SMOKE_EXPECTED_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "active-launch smoke: prebuilt binary requires a 64-character LOOP_SMOKE_EXPECTED_SHA256" >&2
    exit 2
  fi
elif [ -n "${SMOKE_EXPECTED_SHA256}" ]; then
  echo "active-launch smoke: LOOP_SMOKE_EXPECTED_SHA256 requires LOOP_SMOKE_BINARY" >&2
  exit 2
else
  SMOKE_LOOP_BINARY="${SMOKE_ROOT}/build/loop"
fi

binary_sha256() {
  shasum -a 256 "${SMOKE_LOOP_BINARY}" | cut -d ' ' -f 1
}

assert_binary_unchanged() {
  local stage="$1"
  local observed
  if [ "${SMOKE_USES_PREBUILT}" -ne 1 ]; then
    return 0
  fi
  observed="$(binary_sha256)"
  if [ "${observed}" != "${SMOKE_EXPECTED_SHA256}" ]; then
    echo "active-launch smoke: ${stage}: binary hash ${observed} != ${SMOKE_EXPECTED_SHA256}" >&2
    exit 1
  fi
}

smoke_tmux() {
  env -i \
    "HOME=${SMOKE_HOME}" \
    "LANG=C" \
    "LOGNAME=${SMOKE_USER}" \
    "PATH=${SYSTEM_PATH}" \
    "SHELL=/bin/sh" \
    "TERM=xterm-256color" \
    "USER=${SMOKE_USER}" \
    "${REAL_TMUX}" -S "${SMOKE_SOCKET}" "$@"
}

cleanup() {
  local status=$?
  local pid
  trap - EXIT
  for pid in "${FIRST_PID}" "${SECOND_PID}" "${RESUME_FIRST_PID}" "${RESUME_SECOND_PID}" "${DISTINCT_PID}"; do
    if [ -n "${pid}" ]; then
      kill "${pid}" >/dev/null 2>&1 || true
      wait "${pid}" >/dev/null 2>&1 || true
    fi
  done
  smoke_tmux kill-server >/dev/null 2>&1 || true
  if [ "${SMOKE_USES_PREBUILT}" -eq 1 ] && [ -x "${SMOKE_LOOP_BINARY}" ]; then
    if [ "$(binary_sha256 2>/dev/null || true)" != "${SMOKE_EXPECTED_SHA256}" ]; then
      echo "active-launch smoke: cleanup detected a changed prebuilt binary" >&9
      status=1
    fi
  fi
  if [ "${status}" -ne 0 ]; then
    for log in "${SMOKE_ROOT}"/*.out "${SMOKE_ROOT}"/*.err; do
      if [ -s "${log}" ]; then
        echo "active-launch smoke: failure log ${log}" >&9
        sed -n '1,180p' "${log}" >&9
      fi
    done
  fi
  if [ "${status}" -eq 0 ] || [ "${LOOP_SMOKE_KEEP_ON_FAILURE:-0}" != "1" ]; then
    rm -rf "${SMOKE_ROOT}"
  else
    echo "active-launch smoke: preserved failure artifacts at ${SMOKE_ROOT}" >&9
  fi
  exit "${status}"
}
trap cleanup EXIT

run_isolated_launch() {
  local workspace="$1"
  shift
  env -i \
    "CLAUDE_CONFIG_DIR=${SMOKE_ROOT}/claude-config" \
    "CODEX_HOME=${SMOKE_ROOT}/codex-home" \
    "HOME=${SMOKE_HOME}" \
    "LANG=C" \
    "LOGNAME=${SMOKE_USER}" \
    LOOP_AU_PAIR_ENABLED=0 \
    LOOP_NANNY_ENABLED=0 \
    LOOP_RECON_PANES=0 \
    "LOOP_SMOKE_REAL_TMUX=${REAL_TMUX}" \
    "LOOP_TMUX_SOCKET=${SMOKE_SOCKET}" \
    "LOOP_SMOKE_TRACE_PATH=${SMOKE_ROOT}/trace.log" \
    LOOP_UTILITY_PANE=0 \
    "PATH=${SMOKE_BIN}:${SYSTEM_PATH}" \
    "SHELL=/bin/sh" \
    "TERM=xterm-256color" \
    "TMPDIR=${SMOKE_ROOT}/tmp" \
    "TMUX_TMPDIR=${SMOKE_TMUX_TMPDIR}" \
    "USER=${SMOKE_USER}" \
    "XDG_CACHE_HOME=${SMOKE_ROOT}/xdg-cache" \
    "XDG_CONFIG_HOME=${SMOKE_ROOT}/xdg-config" \
    "XDG_DATA_HOME=${SMOKE_ROOT}/xdg-data" \
    "${SMOKE_LOOP_BINARY}" \
    --tmux --agent oss --pair-with claude \
    --workspace "${workspace}" "$@" -p "${PROMPT_PATH}"
}

assert_manifest_set() {
  local expected_count="$1"
  shift
  SMOKE_EXPECTED_TMUX_SOCKET="${SMOKE_SOCKET}" bun -e '
    import { createHash } from "node:crypto";
    import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
    import { dirname, join } from "node:path";
    const [home, promptPath, rawCount, ...bindingArgs] = process.argv.slice(1);
    const expectedCount = Number(rawCount);
    const runsRoot = join(home, ".loop", "runs");
    const files = [];
    const walk = (directory) => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && entry.name === "manifest.json") files.push(path);
      }
    };
    walk(runsRoot);
    if (files.length !== expectedCount) {
      throw new Error(`expected ${expectedCount} manifests, found ${files.length}: ${files.join(", ")}`);
    }
    const prompt = readFileSync(promptPath);
    if (prompt.length < 8192) throw new Error(`prompt too small: ${prompt.length}`);
    const promptSha = createHash("sha256").update(prompt).digest("hex");
    const manifests = files.map((path) => ({ path, value: JSON.parse(readFileSync(path, "utf8")) }));
    const runIds = new Set();
    const repoIds = new Set();
    for (const { path, value: manifest } of manifests) {
      if (manifest.tmuxSocket !== process.env.SMOKE_EXPECTED_TMUX_SOCKET) {
        throw new Error(`${path} socket ${manifest.tmuxSocket ?? "missing"} != ${process.env.SMOKE_EXPECTED_TMUX_SOCKET}`);
      }
      if (!/^[1-9][0-9]*$/.test(manifest.runId)) throw new Error(`non-numeric reserved run ${manifest.runId}`);
      if (runIds.has(manifest.runId)) throw new Error(`duplicate run id ${manifest.runId}`);
      runIds.add(manifest.runId);
      repoIds.add(manifest.repoId);
      if (manifest.status !== "running") throw new Error(`${path} is not active: ${manifest.state}/${manifest.status}`);
      if (!manifest.tmuxSession) throw new Error(`${path} has no tmux session`);
      if (!manifest.launchClaimId) throw new Error(`${path} has no launch claim`);
      if (!manifest.launchAttemptId) throw new Error(`${path} has no launch attempt`);
      if (!(Number.isInteger(manifest.launchAttemptPid) && manifest.launchAttemptPid > 0)) {
        throw new Error(`${path} has no positive launch attempt pid`);
      }
      if (manifest.sourceTaskSha256 !== promptSha) throw new Error(`${path} source charter hash mismatch`);
      if (manifest.workspaceBinding?.repoId !== manifest.repoId) throw new Error(`${path} workspace repo id mismatch`);
      const agents = [manifest.tmuxPaneLeftAgent, manifest.tmuxPaneRightAgent].sort();
      if (JSON.stringify(agents) !== JSON.stringify(["claude", "oss"])) {
        throw new Error(`${path} has unexpected agents ${agents.join("/")}`);
      }
      for (const agent of agents) {
        const charterPath = manifest.launchCharters?.[agent]?.path;
        if (!charterPath) throw new Error(`${path} has no ${agent} charter`);
        const charter = readFileSync(charterPath);
        if (charter.indexOf(prompt) === -1) throw new Error(`${agent} charter omitted or truncated the prompt`);
      }
      const hookPath = join(dirname(path), "hooks", "claude.jsonl");
      if (!existsSync(hookPath)) throw new Error(`${path} has no Claude kickoff hook evidence`);
      const kickoff = readFileSync(hookPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
        .filter((event) => event.event === "UserPromptSubmit");
      if (kickoff.length !== 1) throw new Error(`${path} has ${kickoff.length} Claude kickoff events`);
      const [event] = kickoff;
      if (event.agent !== "claude" || event.eventId !== `smoke-kickoff-${manifest.runId}` ||
          event.source !== "agent-hook" || event.state !== "working" || event.sequence !== 1) {
        throw new Error(`${path} has malformed Claude kickoff evidence`);
      }
    }
    if (repoIds.size !== 1) throw new Error(`expected one repository identity, got ${[...repoIds].join(",")}`);
    for (let index = 0; index < bindingArgs.length; index += 2) {
      const root = realpathSync(bindingArgs[index]);
      const branchRef = bindingArgs[index + 1];
      const matches = manifests.filter(({ value }) =>
        realpathSync(value.workspaceBinding?.root ?? value.cwd) === root &&
        value.workspaceBinding?.branchRef === branchRef
      );
      if (matches.length !== 1) throw new Error(`expected one manifest for ${root} on ${branchRef}, found ${matches.length}`);
      if (realpathSync(matches[0].value.cwd) !== root) throw new Error(`manifest cwd mismatch for ${root}`);
    }
    process.stdout.write(manifests.map(({ value }) => value.tmuxSession).sort().join("\n"));
  ' "${SMOKE_HOME}" "${PROMPT_PATH}" "${expected_count}" "$@"
}

assert_tmux_sessions() {
  local expected_count="$1"
  local expected_sessions="$2"
  local observed_sessions
  local observed_count
  observed_sessions="$(smoke_tmux list-sessions -F '#{session_name}' | sort)"
  observed_count="$(printf '%s\n' "${observed_sessions}" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "${observed_count}" -ne "${expected_count}" ]; then
    echo "active-launch smoke: expected ${expected_count} live tmux sessions, found ${observed_count}: ${observed_sessions}" >&2
    exit 1
  fi
  if [ "${observed_sessions}" != "${expected_sessions}" ]; then
    echo "active-launch smoke: manifest sessions and live sessions differ" >&2
    echo "manifest: ${expected_sessions}" >&2
    echo "live: ${observed_sessions}" >&2
    exit 1
  fi
}

wait_for_bootstraps() {
  local pairs
  local pane
  local agent
  local output
  pairs="$(bun -e '
    import { readFileSync, readdirSync } from "node:fs";
    import { join } from "node:path";
    const root = join(process.argv[1], ".loop", "runs");
    for (const repo of readdirSync(root)) {
      for (const run of readdirSync(join(root, repo))) {
        const path = join(root, repo, run, "manifest.json");
        try {
          const manifest = JSON.parse(readFileSync(path, "utf8"));
          console.log(`${manifest.tmuxPaneLeft}|${manifest.tmuxPaneLeftAgent}`);
          console.log(`${manifest.tmuxPaneRight}|${manifest.tmuxPaneRightAgent}`);
        } catch {}
      }
    }
  ' "${SMOKE_HOME}")"
  while IFS='|' read -r pane agent; do
    if [ -z "${pane}" ] || [ -z "${agent}" ]; then
      echo "active-launch smoke: incomplete pane binding" >&2
      exit 1
    fi
    output=""
    for _attempt in $(seq 1 40); do
      output="$(smoke_tmux capture-pane -p -J -S -120 -t "${pane}")"
      if grep -Eq "BOOTSTRAP_(VERIFIED|RESUME) ${agent}" <<<"${output}"; then
        break
      fi
      sleep 0.25
    done
    if ! grep -Eq "BOOTSTRAP_(VERIFIED|RESUME) ${agent}" <<<"${output}"; then
      echo "active-launch smoke: ${agent} pane ${pane} did not verify its charter" >&2
      printf '%s\n' "${output}" >&2
      exit 1
    fi
  done <<<"${pairs}"
}

mkdir -p \
  "${SMOKE_BIN}" \
  "${SMOKE_HOME}/.cache/loop/update" \
  "${SMOKE_ROOT}/build" \
  "${SMOKE_ROOT}/claude-config" \
  "${SMOKE_ROOT}/codex-home" \
  "${SMOKE_ROOT}/tmp" \
  "${SMOKE_TMUX_TMPDIR}" \
  "${SMOKE_ROOT}/xdg-cache" \
  "${SMOKE_ROOT}/xdg-config" \
  "${SMOKE_ROOT}/xdg-data"
chmod 700 \
  "${SMOKE_HOME}" \
  "${SMOKE_ROOT}/claude-config" \
  "${SMOKE_ROOT}/codex-home" \
  "${SMOKE_ROOT}/tmp" \
  "${SMOKE_TMUX_TMPDIR}"
printf '{"lastCheck":"%s"}\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  >"${SMOKE_HOME}/.cache/loop/update/last-check.json"

cp "${HASH_TUI}" "${SMOKE_BIN}/opencode"
cp "${HASH_TUI}" "${SMOKE_BIN}/claude"
cp "${TMUX_WRAPPER}" "${SMOKE_BIN}/tmux"
chmod +x "${SMOKE_BIN}/"*

if [ "${SMOKE_USES_PREBUILT}" -ne 1 ]; then
  (cd "${LOOP_ROOT}" && bun build --compile --outfile "${SMOKE_LOOP_BINARY}" src/cli.ts >/dev/null)
fi
assert_binary_unchanged "before launch"

git init -q "${SMOKE_REPO}"
git -C "${SMOKE_REPO}" config user.email loop-smoke@example.invalid
git -C "${SMOKE_REPO}" config user.name "Loop Smoke"
printf 'active launch interlock fixture\n' >"${SMOKE_REPO}/README.md"
git -C "${SMOKE_REPO}" add README.md
git -C "${SMOKE_REPO}" commit -q -m fixture
git -C "${SMOKE_REPO}" worktree add -q -b smoke/workspace-one "${WORKSPACE_ONE}"
git -C "${SMOKE_REPO}" worktree add -q -b smoke/workspace-two "${WORKSPACE_TWO}"

{
  printf 'BEGIN-LARGE-CHARTER\n'
  awk 'BEGIN { for (i = 0; i < 10257; i++) printf "x" }'
  printf '\nEND-LARGE-CHARTER\n'
} >"${PROMPT_PATH}"

(
  while [ ! -e "${START_GATE}" ]; do sleep 0.01; done
  run_isolated_launch "${WORKSPACE_ONE}"
) >"${SMOKE_ROOT}/same-a.out" 2>"${SMOKE_ROOT}/same-a.err" &
FIRST_PID=$!
(
  while [ ! -e "${START_GATE}" ]; do sleep 0.01; done
  run_isolated_launch "${WORKSPACE_ONE}"
) >"${SMOKE_ROOT}/same-b.out" 2>"${SMOKE_ROOT}/same-b.err" &
SECOND_PID=$!
: >"${START_GATE}"

set +e
wait "${FIRST_PID}"
FIRST_STATUS=$?
FIRST_PID=""
wait "${SECOND_PID}"
SECOND_STATUS=$?
SECOND_PID=""
set -e

if [ "${FIRST_STATUS}" -eq 0 ] && [ "${SECOND_STATUS}" -ne 0 ]; then
  LOSER_LOG="${SMOKE_ROOT}/same-b.err"
elif [ "${SECOND_STATUS}" -eq 0 ] && [ "${FIRST_STATUS}" -ne 0 ]; then
  LOSER_LOG="${SMOKE_ROOT}/same-a.err"
else
  echo "active-launch smoke: expected one winner and one loser, got ${FIRST_STATUS}/${SECOND_STATUS}" >&2
  exit 1
fi
grep -Fq '[loop] launch conflict:' "${LOSER_LOG}"

FIRST_SESSIONS="$(assert_manifest_set 1 \
  "${WORKSPACE_ONE}" refs/heads/smoke/workspace-one)"
assert_tmux_sessions 1 "${FIRST_SESSIONS}"
wait_for_bootstraps

FIRST_BINDING="$(bun -e '
  import { readFileSync, readdirSync } from "node:fs";
  import { join } from "node:path";
  const root = join(process.argv[1], ".loop", "runs");
  for (const repo of readdirSync(root)) {
    for (const run of readdirSync(join(root, repo))) {
      try {
        const manifest = JSON.parse(readFileSync(join(root, repo, run, "manifest.json"), "utf8"));
        if (manifest.workspaceBinding?.branchRef === "refs/heads/smoke/workspace-one") {
          process.stdout.write([manifest.runId, manifest.tmuxSession, manifest.launchClaimId, manifest.sourceTaskSha256].join("|"));
        }
      } catch {}
    }
  }
' "${SMOKE_HOME}")"
IFS='|' read -r FIRST_RUN_ID FIRST_SESSION FIRST_CLAIM FIRST_TASK_SHA <<<"${FIRST_BINDING}"
if [ -z "${FIRST_RUN_ID}" ] || [ -z "${FIRST_SESSION}" ] || [ -z "${FIRST_CLAIM}" ] || [ -z "${FIRST_TASK_SHA}" ]; then
  echo "active-launch smoke: incomplete first-run binding ${FIRST_BINDING}" >&2
  exit 1
fi
smoke_tmux kill-session -t "${FIRST_SESSION}"

(
  while [ ! -e "${RESUME_GATE}" ]; do sleep 0.01; done
  run_isolated_launch "${WORKSPACE_ONE}" --run-id "${FIRST_RUN_ID}"
) >"${SMOKE_ROOT}/resume-a.out" 2>"${SMOKE_ROOT}/resume-a.err" &
RESUME_FIRST_PID=$!
(
  while [ ! -e "${RESUME_GATE}" ]; do sleep 0.01; done
  run_isolated_launch "${WORKSPACE_ONE}" --run-id "${FIRST_RUN_ID}"
) >"${SMOKE_ROOT}/resume-b.out" 2>"${SMOKE_ROOT}/resume-b.err" &
RESUME_SECOND_PID=$!
: >"${RESUME_GATE}"

set +e
wait "${RESUME_FIRST_PID}"
RESUME_FIRST_STATUS=$?
RESUME_FIRST_PID=""
wait "${RESUME_SECOND_PID}"
RESUME_SECOND_STATUS=$?
RESUME_SECOND_PID=""
set -e
if [ "${RESUME_FIRST_STATUS}" -eq 0 ] && [ "${RESUME_SECOND_STATUS}" -ne 0 ]; then
  RESUME_LOSER_LOG="${SMOKE_ROOT}/resume-b.err"
elif [ "${RESUME_SECOND_STATUS}" -eq 0 ] && [ "${RESUME_FIRST_STATUS}" -ne 0 ]; then
  RESUME_LOSER_LOG="${SMOKE_ROOT}/resume-a.err"
else
  echo "active-launch smoke: expected one resume winner and one loser, got ${RESUME_FIRST_STATUS}/${RESUME_SECOND_STATUS}" >&2
  exit 1
fi
grep -Fq '[loop] launch conflict:' "${RESUME_LOSER_LOG}"

RESUMED_SESSIONS="$(assert_manifest_set 1 \
  "${WORKSPACE_ONE}" refs/heads/smoke/workspace-one)"
assert_tmux_sessions 1 "${RESUMED_SESSIONS}"
wait_for_bootstraps
RESUMED_BINDING="$(bun -e '
  import { readFileSync, readdirSync } from "node:fs";
  import { join } from "node:path";
  const root = join(process.argv[1], ".loop", "runs");
  for (const repo of readdirSync(root)) for (const run of readdirSync(join(root, repo))) {
    try {
      const manifest = JSON.parse(readFileSync(join(root, repo, run, "manifest.json"), "utf8"));
      if (manifest.workspaceBinding?.branchRef === "refs/heads/smoke/workspace-one") {
        process.stdout.write([manifest.runId, manifest.launchClaimId, manifest.sourceTaskSha256].join("|"));
      }
    } catch {}
  }
' "${SMOKE_HOME}")"
if [ "${RESUMED_BINDING}" != "${FIRST_RUN_ID}|${FIRST_CLAIM}|${FIRST_TASK_SHA}" ]; then
  echo "active-launch smoke: cold resume changed immutable binding ${RESUMED_BINDING}" >&2
  exit 1
fi

set +e
run_isolated_launch "${WORKSPACE_TWO}" \
  >"${SMOKE_ROOT}/distinct.out" 2>"${SMOKE_ROOT}/distinct.err" &
DISTINCT_PID=$!
wait "${DISTINCT_PID}"
DISTINCT_STATUS=$?
DISTINCT_PID=""
set -e
if [ "${DISTINCT_STATUS}" -ne 0 ]; then
  echo "active-launch smoke: distinct registered worktree launch failed with ${DISTINCT_STATUS}" >&2
  exit 1
fi

ALL_SESSIONS="$(assert_manifest_set 2 \
  "${WORKSPACE_ONE}" refs/heads/smoke/workspace-one \
  "${WORKSPACE_TWO}" refs/heads/smoke/workspace-two)"
assert_tmux_sessions 2 "${ALL_SESSIONS}"
wait_for_bootstraps
assert_binary_unchanged "after launch"

echo "active-launch smoke: binary=${SMOKE_LOOP_BINARY} binary-sha256=$(binary_sha256) prebuilt=${SMOKE_USES_PREBUILT} prompt-bytes=$(wc -c <"${PROMPT_PATH}" | tr -d ' ') same-workspace-status=${FIRST_STATUS}/${SECOND_STATUS} cold-resume-status=${RESUME_FIRST_STATUS}/${RESUME_SECOND_STATUS} immutable-resume-binding=preserved winner-sessions=1 winner-manifests=1 distinct-worktree=allowed final-sessions=2 final-manifests=2 host-home=isolated tmux-socket=isolated"
