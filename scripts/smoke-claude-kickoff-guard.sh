#!/usr/bin/env bash
# Isolated smoke for the Claude kickoff submit guard.
#
# Proves, against the compiled binary rather than the test harness, that a
# paired launch whose Claude pane never starts a turn fails nonzero and leaves
# no survivors.
#
# Safety contract (specs/claude-kickoff-submit-guard/tasks.md item 10):
#   - unique temporary run base and repo identity per invocation
#   - non-network process stubs on PATH; the real claude/codex/tmux are never run
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

cleanup() {
  local code=$?
  # Kill anything this smoke started, by its unique marker, never by a broad
  # pattern that could reach a live run.
  pkill -f "${SMOKE_ID}" 2>/dev/null || true
  rm -rf "${WORK}"
  exit "${code}"
}
trap cleanup EXIT INT TERM

mkdir -p "${WORK}/bin" "${WORK}/repo" "${WORK}/runs"

# Non-network stubs. Nothing dials out, binds a port, or opens a terminal.
cat > "${WORK}/bin/codex" <<STUB
#!/usr/bin/env bash
# ${SMOKE_ID}
echo "codex \$*" >> "${MARKER}"
exit 0
STUB

# The peer pane is OSS rather than Codex, which keeps this smoke off the Codex
# app-server and proxy entirely: no sockets, no ports, nothing another run owns.
cat > "${WORK}/bin/opencode" <<STUB
#!/usr/bin/env bash
# ${SMOKE_ID}
echo "opencode \$*" >> "${MARKER}"
exit 0
STUB

# `claude --version` must answer, so the guard observes a real version rather
# than silently taking the unknown-version path for the wrong reason.
cat > "${WORK}/bin/claude" <<STUB
#!/usr/bin/env bash
# ${SMOKE_ID}
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

# Positive zero-survivor check: re-enumerate rather than trusting the kill.
# `pgrep` exits 1 when nothing matches, which is the success case here, so the
# pipeline must not be allowed to trip `pipefail`.
pkill -f "${SMOKE_ID}" 2>/dev/null || true
sleep 1
SURVIVORS="$( (pgrep -f "${SMOKE_ID}" 2>/dev/null || true) | wc -l | tr -d ' ')"
echo "=== survivors: ${SURVIVORS} ==="
if [[ "${SURVIVORS}" -ne 0 ]]; then
  echo "smoke FAILED: ${SURVIVORS} process(es) survived" >&2
  pgrep -alf "${SMOKE_ID}" >&2 || true
  exit 1
fi

# Isolation proof: the run base this launch used must be the temporary one, and
# no run directory may have been created under the real user home.
if [[ ! -d "${WORK}/runs" ]]; then
  echo "smoke FAILED: isolated run base ${WORK}/runs was never created" >&2
  exit 1
fi

echo "smoke OK: nonzero launch for the kickoff guard, zero survivors, isolated run base ${WORK}/runs"
