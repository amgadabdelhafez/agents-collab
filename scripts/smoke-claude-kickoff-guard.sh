#!/usr/bin/env bash
# Isolated smoke for the Claude kickoff submit guard.
#
# Proves, against the compiled binary rather than the test harness, that a
# paired launch whose Claude pane never starts a turn fails nonzero and leaves
# no survivors.
#
# Safety contract (specs/claude-kickoff-submit-guard/tasks.md item 10):
#   - unique temporary run base and repo identity per invocation
#   - non-network: PATH stubs for the binaries, PLUS a seeded auto-update
#     throttle sentinel that is asserted byte-identical afterwards, because the
#     launcher reaches GitHub through runtime fetch() that no PATH stub blocks
#   - bounded concurrency: one launch, one bounded wait
#   - trap cleanup, then a POSITIVE zero-survivor check that re-enumerates
#   - never touches a live run directory, live repo identity, or a port owned by
#     another run
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${REPO_ROOT}/loop-fork/loop"
if [[ ! -x "${BIN}" ]]; then
  echo "smoke: missing built binary ${BIN}; run 'bun run build' in loop-fork first" >&2
  exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loop-kickoff-smoke-XXXXXX")"
SMOKE_ID="kickoff-smoke-$$"
MARKER="${WORK}/marker"
# Every stub appends its own PID here. Survivor enumeration walks these exact
# identities. An earlier version of this script searched `pgrep -f "$SMOKE_ID"`,
# but SMOKE_ID only ever appeared inside the stub FILE CONTENTS, never in any
# spawned process's command line, so the check could return zero without having
# examined a single process the smoke started. That is a fail-open, and the
# recorded-PID form below is what replaced it.
PIDFILE="${WORK}/spawned-pids"

# The launcher reaches the GitHub release API through runtime `fetch()`, which
# no PATH stub can intercept: with TMUX unset, `shouldAwaitAutoUpdate`
# (src/cli.ts:79) makes a promptless paired launch await `awaitAutoUpdateCheck`,
# and `shouldThrottle` (src/loop/update.ts:84) returns false when the sentinel
# is missing under a fresh HOME. Seeding a current sentinel stops the call at
# its source; asserting the sentinel is byte-identical afterwards is what proves
# it stayed stopped, because `saveCheckTime` would rewrite it if a check ran.
UPDATE_CACHE="${WORK}/.cache/loop/update"
UPDATE_CHECK_FILE="${UPDATE_CACHE}/last-check.json"
UPDATE_SENTINEL_SHA=""

# A recorded PID is not durable identity: these stubs exit immediately and the
# kernel recycles PIDs, so signalling a bare recorded number could hit an
# unrelated process. Ownership is re-validated before any signal by requiring
# the live process's command line to reference this smoke's unique WORK path.
owned_by_smoke() {
  local pid="$1"
  ps -o command= -p "${pid}" 2>/dev/null | grep -qF "${WORK}"
}

survivors() {
  # Echoes recorded PIDs that are still alive AND still owned by this smoke.
  [[ -f "${PIDFILE}" ]] || return 0
  local pid
  while read -r pid; do
    [[ -n "${pid}" ]] || continue
    if kill -0 "${pid}" 2>/dev/null && owned_by_smoke "${pid}"; then
      echo "${pid}"
    fi
  done < "${PIDFILE}"
}

cleanup() {
  local code=$?
  # Signal only PIDs this smoke recorded that are STILL this smoke's, never a
  # bare recycled number and never a broad pattern that could reach a live run.
  if [[ -f "${PIDFILE}" ]]; then
    while read -r pid; do
      [[ -n "${pid}" ]] || continue
      if owned_by_smoke "${pid}"; then
        # `|| true` matters: killing an already-exited stub returns nonzero, and
        # `set -e` inside an EXIT trap would otherwise overwrite the real exit
        # code and report a passing smoke as a failure.
        kill "${pid}" 2>/dev/null || true
      fi
    done < "${PIDFILE}"
  fi
  rm -rf "${WORK}"
  exit "${code}"
}
trap cleanup EXIT INT TERM

mkdir -p "${WORK}/bin" "${WORK}/repo" "${WORK}/runs"

# Non-network stubs. Nothing dials out, binds a port, or opens a terminal.
cat > "${WORK}/bin/codex" <<STUB
#!/usr/bin/env bash
# ${SMOKE_ID}
echo "\$\$" >> "${PIDFILE}"
echo "codex \$*" >> "${MARKER}"
exit 0
STUB

# The peer pane is OSS rather than Codex, which keeps this smoke off the Codex
# app-server and proxy entirely: no sockets, no ports, nothing another run owns.
cat > "${WORK}/bin/opencode" <<STUB
#!/usr/bin/env bash
# ${SMOKE_ID}
echo "\$\$" >> "${PIDFILE}"
echo "opencode \$*" >> "${MARKER}"
exit 0
STUB

# `claude --version` must answer, so the guard observes a real version rather
# than silently taking the unknown-version path for the wrong reason.
cat > "${WORK}/bin/claude" <<STUB
#!/usr/bin/env bash
# ${SMOKE_ID}
echo "\$\$" >> "${PIDFILE}"
echo "claude \$*" >> "${MARKER}"
if [[ "\$1" == "--version" ]]; then
  echo "2.1.223 (Claude Code)"
fi
exit 0
STUB

# Stateful tmux stub: enough fidelity to reach the kickoff seam, and no more.
# `capture-pane` always reports a ready-empty composer, so the launcher pastes,
# sends Enter, and then finds no turn evidence: the run-147 shape.
cat > "${WORK}/bin/tmux" <<STUB
#!/usr/bin/env bash
# ${SMOKE_ID}
echo "\$\$" >> "${PIDFILE}"
echo "tmux \$*" >> "${MARKER}"
STATE="${WORK}/tmux-session"
case "\$1" in
  has-session)
    if [[ -f "\$STATE" ]]; then
      exit 0
    fi
    # Real tmux wording, so the launcher can tell "dead" from "unknown".
    echo "can't find session: smoke" >&2
    exit 1
    ;;
  new-session)
    touch "\$STATE"
    echo "%0"
    ;;
  split-window)
    echo "%1"
    ;;
  capture-pane)
    printf '\xe2\x9d\xaf \n'
    ;;
  display-message)
    echo "0 0 1 0 0"
    ;;
  kill-session)
    rm -f "\$STATE"
    ;;
esac
exit 0
STUB

for stub in claude codex opencode tmux; do
  chmod +x "${WORK}/bin/${stub}"
done

cd "${WORK}/repo"
# A throwaway repo identity: this smoke must never resolve to a live repo id.
git init -q
git config user.email "smoke@example.invalid"
git config user.name "kickoff smoke"
# A pre-existing PLAN.md lets the launcher skip planning and go straight to the
# paired tmux startup this smoke is about.
printf '# smoke plan\n\nExercise the Claude kickoff submit guard.\n' > PLAN.md
git add PLAN.md
git -c commit.gpgsign=false commit -q -m "smoke base"

# Seed the auto-update throttle BEFORE the launch, and record its hash so the
# teardown assertion below is comparing against a known value.
mkdir -p "${UPDATE_CACHE}"
printf '{"lastCheck":"%s"}' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > "${UPDATE_CHECK_FILE}"
UPDATE_SENTINEL_SHA="$(shasum -a 256 "${UPDATE_CHECK_FILE}" | cut -d ' ' -f 1)"

set +e
env -u TMUX -u TMUX_PANE \
  PATH="${WORK}/bin:${PATH}" \
  HOME="${WORK}" \
  LOOP_RUN_BASE="${WORK}/runs" \
  LOOP_RUN_ID="1" \
  "${BIN}" --tmux --agent claude --pair-with oss \
  > "${WORK}/stdout.log" 2> "${WORK}/stderr.log"
LAUNCH_EXIT=$?
set -e

echo "=== launch exit: ${LAUNCH_EXIT} ==="
if [[ "${LAUNCH_EXIT}" -eq 0 ]]; then
  echo "smoke FAILED: a launch with no Claude turn evidence exited 0" >&2
  tail -20 "${WORK}/stdout.log" "${WORK}/stderr.log" >&2 || true
  exit 1
fi

# A nonzero exit is not enough: assert it failed for the reason under test and
# not for some unrelated startup error. Wrapped text is joined first so a line
# break inside the message cannot hide the phrase.
REASON="Claude pane"
if ! tr '\n' ' ' < "${WORK}/stderr.log" | grep -q "never started a turn from the launcher kickoff"; then
  echo "smoke FAILED: nonzero exit, but not for the kickoff guard" >&2
  echo "--- stderr ---" >&2
  tail -30 "${WORK}/stderr.log" >&2 || true
  exit 1
fi
tr '\n' ' ' < "${WORK}/stderr.log" | grep -o "${REASON} [^ ]*" | head -1

# The survivor check must not be vacuous. Absence of evidence has to fail, so
# first prove the smoke actually observed processes: if no stub ever recorded a
# PID, there is nothing to enumerate and the "zero survivors" claim would be
# meaningless.
SPAWNED="$( [[ -f "${PIDFILE}" ]] && wc -l < "${PIDFILE}" | tr -d ' ' || echo 0 )"
echo "=== recorded stub processes: ${SPAWNED} ==="
if [[ "${SPAWNED}" -eq 0 ]]; then
  echo "smoke FAILED: no stub process was ever recorded, so the survivor check would be vacuous" >&2
  exit 1
fi

# Positive zero-survivor check over those exact recorded identities.
sleep 1
REMAINING="$(survivors | tr '\n' ' ' | sed 's/ *$//')"
echo "=== survivors: ${REMAINING:-none} ==="
if [[ -n "${REMAINING}" ]]; then
  echo "smoke FAILED: recorded processes survived: ${REMAINING}" >&2
  # shellcheck disable=SC2086
  ps -o pid,command -p ${REMAINING} >&2 || true
  exit 1
fi

# Network denial, asserted rather than claimed. `saveCheckTime` rewrites the
# sentinel whenever an update check runs, so a byte-identical sentinel is
# positive evidence that no check — and therefore no GitHub fetch — happened.
# A staged binary would be direct evidence of a download.
SENTINEL_NOW="$(shasum -a 256 "${UPDATE_CHECK_FILE}" 2>/dev/null | cut -d ' ' -f 1)"
if [[ "${SENTINEL_NOW}" != "${UPDATE_SENTINEL_SHA}" ]]; then
  echo "smoke FAILED: auto-update throttle sentinel was rewritten (${SENTINEL_NOW} != ${UPDATE_SENTINEL_SHA}); the run performed an update check and may have gone to the network" >&2
  exit 1
fi
echo "=== auto-update sentinel intact: no update check ran ==="
if [[ -e "${UPDATE_CACHE}/loop-staged" ]]; then
  echo "smoke FAILED: a staged update binary was downloaded into the sandbox" >&2
  exit 1
fi

# The launcher's failed-start cleanup must have torn down the tmux session, not
# merely exited. The stateful stub removes this file on `kill-session`.
if [[ -f "${WORK}/tmux-session" ]]; then
  echo "smoke FAILED: tmux session state survived the failed launch" >&2
  exit 1
fi
if ! grep -q "tmux kill-session" "${MARKER}"; then
  echo "smoke FAILED: the launcher never issued kill-session" >&2
  exit 1
fi

# Isolation proof: the run base this launch used must be the temporary one, and
# no run directory may have been created under the real user home.
if [[ ! -d "${WORK}/runs" ]]; then
  echo "smoke FAILED: isolated run base ${WORK}/runs was never created" >&2
  exit 1
fi

echo "smoke OK: nonzero launch for the kickoff guard, ${SPAWNED} recorded stub processes, zero survivors, tmux session torn down, isolated run base ${WORK}/runs"
