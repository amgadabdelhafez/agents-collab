#!/usr/bin/env bash
# Compiled-binary smoke for the provider-neutral OSS agent seat.
#
# Exercises the real `loop` executable, not the TypeScript sources, so the
# shipped artifact is what gets certified. No provider calls are made.
#
# ISOLATION CONTRACT
# ------------------
# The previous revision of this smoke escaped isolation. It invoked the real
# launcher with real launch argv (`--agent gemini --proof x`, `--cursor-only`,
# ...) while inheriting the caller's environment. Run identity is derived from
# `$HOME` (`resolveStorageRoot`) and from the cwd's git identity
# (`resolveRepoId`), so every probe resolved the *live* run directory. Any probe
# that did not fail closed therefore launched for real: it spawned panes and
# placeholder processes, reconciled against the live manifest, and killed the
# peer agent's proxy. The harness's safety depended on the very property under
# test, which makes a regression catastrophic instead of red.
#
# This revision is safe independently of the code under test:
#
#   * unique temporary $HOME          - run storage cannot resolve to the real
#                                       root even if the binary tries
#   * unique temporary git repo (cwd) - unique repo id, so an escape is
#                                       detectable by name and cannot collide
#                                       with a real run
#   * `env -i` + stubbed PATH         - no inherited TMUX, no LOOP_* carry-over,
#                                       no credentials, no network *binaries*
#   * sandboxed copy of the binary    - the launcher's self-update writes over
#                                       `process.execPath`, so the binary under
#                                       test must live inside the sandbox or a
#                                       staged update would overwrite the real
#                                       one. The copy is sha256-verified against
#                                       the original so certification still
#                                       refers to the requested artifact.
#   * seeded auto-update throttle     - PATH stubs cannot block the launcher's
#                                       runtime `fetch()` to the GitHub release
#                                       API. Seeding the throttle file inside the
#                                       sandbox HOME short-circuits the check
#                                       before any network call, and the seed is
#                                       a sentinel that the run re-verifies.
#   * per-probe session/process group - a timeout kills the whole group, not
#                                       just the direct child
#   * hard probe cap                  - bounded work, one probe at a time
#   * trap-based teardown             - EXIT/INT/TERM/HUP/PIPE all tear down.
#                                       PIPE matters: piping this script's stdout
#                                       into a truncating consumer (`| head -2`)
#                                       kills it with SIGPIPE, and the default
#                                       action skips the EXIT trap entirely,
#                                       leaking the sandbox. Observed, then fixed.
#                                       KNOWN LIMIT: with stdout a closed pipe,
#                                       teardown completes but its own report
#                                       lines fail to write, and the survivor
#                                       checks have been observed reporting false
#                                       positives in that state. The failure is
#                                       conservative - it exits 3 and preserves
#                                       the sandbox rather than declaring success
#                                       - but do not read a piped run's teardown
#                                       output as authoritative. Run it unpiped,
#                                       or redirect to a file.
#   * instrument check before probes  - isolation is *proven* to hold before any
#                                       launch-shaped argv is used; if it cannot
#                                       be proven the smoke aborts (fail closed)
#   * producer-backed survivor proof  - teardown asserts: no sandbox-owned
#                                       member remains in any recorded process
#                                       group; every pid the stubs recorded about
#                                       themselves is dead; no process carries
#                                       the marker in argv; the real storage root
#                                       gained no directory for this repo id; the
#                                       update sentinel is intact. Scope note:
#                                       `pgrep -f` matches argv, not environment,
#                                       so these prove exactly those properties -
#                                       not the general absence of listeners.
set -euo pipefail

# Self-identify before anything else. A log that names only the binary under
# test cannot be bound to the harness that produced it, so any later edit to this
# file would silently inherit the credibility of an older run's evidence.
# Printing the harness's own hash makes every edit visibly invalidate prior logs.
HARNESS_PATH="${BASH_SOURCE[0]}"
HARNESS_SHA256="$(shasum -a 256 "${HARNESS_PATH}" | cut -d ' ' -f 1)"
echo "oss-agent-seat smoke: harness ${HARNESS_PATH} sha256=${HARNESS_SHA256}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOOP_ROOT="${REPO_ROOT}/loop-fork"
SMOKE_LOOP_BINARY="${LOOP_SMOKE_BINARY:-${LOOP_ROOT}/loop}"
SMOKE_EXPECTED_SHA256="${LOOP_SMOKE_EXPECTED_SHA256:-}"
FAILURES=0

if [ ! -x "${SMOKE_LOOP_BINARY}" ]; then
  echo "oss-agent-seat smoke: binary is not executable: ${SMOKE_LOOP_BINARY}" >&2
  exit 2
fi

BINARY_SHA256="$(shasum -a 256 "${SMOKE_LOOP_BINARY}" | cut -d ' ' -f 1)"
if [ -n "${SMOKE_EXPECTED_SHA256}" ] &&
  [ "${BINARY_SHA256}" != "${SMOKE_EXPECTED_SHA256}" ]; then
  echo "oss-agent-seat smoke: binary hash ${BINARY_SHA256} != ${SMOKE_EXPECTED_SHA256}" >&2
  exit 1
fi
echo "oss-agent-seat smoke: binary ${SMOKE_LOOP_BINARY} sha256=${BINARY_SHA256}"

fail() {
  echo "  FAIL: $*" >&2
  FAILURES=$((FAILURES + 1))
}

pass() {
  echo "  ok: $*"
}

# --- isolation setup --------------------------------------------------------

REAL_HOME="${HOME}"
REAL_STORAGE_ROOT="${REAL_HOME}/.loop/runs"
SMOKE_MARKER="oss-agent-seat-smoke-$$-$(od -An -N4 -tx4 </dev/urandom | tr -d ' ')"
SMOKE_TMP_RAW="$(mktemp -d "${TMPDIR:-/tmp}/${SMOKE_MARKER}.XXXXXX")"
# Arm a minimal cleanup on the very next line after the directory exists. Every
# step below can fail - the normalising `cd`, `mkdir`, evidence-file creation,
# the binary copy - and without this the sandbox would be left behind with no
# teardown at all. The trap keeps the RAW path: normalisation reassigns
# SMOKE_TMP, and a failed `cd` would set it to the empty string, so a trap that
# read only SMOKE_TMP would `rm -rf ""` and leak the directory it was meant to
# remove. Replaced by the full `teardown` below.
SMOKE_TMP=""
trap 'rm -rf "${SMOKE_TMP_RAW}" "${SMOKE_TMP:-${SMOKE_TMP_RAW}}"' \
  EXIT INT TERM HUP PIPE
# $TMPDIR often ends in a slash, so mktemp can hand back `/T//name`. The
# launcher normalises the path it embeds in argv, and a doubled slash here would
# silently break every path comparison below.
SMOKE_TMP="$(cd "${SMOKE_TMP_RAW}" && pwd -P)"
SMOKE_HOME="${SMOKE_TMP}/home"
SMOKE_REPO="${SMOKE_TMP}/${SMOKE_MARKER}-repo"
SMOKE_BIN="${SMOKE_TMP}/bin"
SMOKE_EVIDENCE="${SMOKE_TMP}/evidence"
SMOKE_SPAWNED="${SMOKE_EVIDENCE}/spawned.tsv"
SMOKE_PGIDS="${SMOKE_EVIDENCE}/pgids.txt"
SMOKE_PROBE_TIMEOUT_S="${LOOP_SMOKE_PROBE_TIMEOUT_S:-20}"
SMOKE_MAX_PROBES="${LOOP_SMOKE_MAX_PROBES:-96}"
# Probes run inside `$(...)`, so a shell variable counter would be incremented
# in a subshell and silently never enforce the cap. Keep the count in a file.
SMOKE_PROBE_COUNT_FILE="${SMOKE_EVIDENCE}/probe-count"
TEARDOWN_DONE=0

mkdir -p "${SMOKE_HOME}" "${SMOKE_REPO}" "${SMOKE_BIN}" "${SMOKE_EVIDENCE}" \
  "${SMOKE_TMP}/tmp" "${SMOKE_TMP}/under-test" "${SMOKE_HOME}/.cache/loop/update"
: >"${SMOKE_SPAWNED}"
: >"${SMOKE_PGIDS}"
printf '0\n' >"${SMOKE_PROBE_COUNT_FILE}"

# Declared before `teardown` is defined and installed, so that once it becomes
# the trap it can never reference an unset variable under `set -u`. Until the
# sentinel is actually seeded further down, the sha stays empty and teardown
# skips that check rather than reporting a rewrite that never happened.
UPDATE_CHECK_FILE="${SMOKE_HOME}/.cache/loop/update/last-check.json"
UPDATE_SENTINEL_SHA=""

# Teardown runs on every exit path, including a failed `set -e` assertion.
teardown() {
  local exit_code=$?
  [ "${TEARDOWN_DONE}" -eq 1 ] && return
  TEARDOWN_DONE=1
  set +e
  # If stdout is a closed pipe, every line printed below would raise SIGPIPE and
  # kill this function part-way through - leaving the sandbox behind precisely
  # when cleanup matters. Ignoring PIPE here turns those into harmless write
  # errors that `set +e` tolerates, so cleanup always completes.
  trap '' PIPE

  # Members of a process group this smoke created, and only those. A pgid is
  # just a recycled integer: once a probe group has fully exited the kernel may
  # hand that number to an unrelated process, so signalling every historical
  # pgid could kill a peer agent. Re-validate ownership by requiring a member's
  # command line to reference this sandbox before touching it.
  #
  # KNOWN LIMIT: the ownership check and the kill are separate operations, so a
  # group that exits between them and has its pgid immediately reused would be
  # signalled on stale information. Closing that fully needs a pidfd-style
  # anchor the shell does not have. Recorded rather than claimed away.
  owned_members() {
    ps -A -o pgid=,pid=,command= 2>/dev/null |
      awk -v g="$1" -v s="${SMOKE_TMP}" '$1 == g && index($0, s) > 0 {print}'
  }

  # Kill every still-owned probe process group, not just direct children.
  local pass_signal
  for pass_signal in TERM KILL; do
    while read -r pgid; do
      [ -n "${pgid}" ] || continue
      [ -n "$(owned_members "${pgid}")" ] || continue
      kill "-${pass_signal}" "-${pgid}" 2>/dev/null
    done <"${SMOKE_PGIDS}"
    [ "${pass_signal}" = "TERM" ] && sleep 1
  done

  echo "--- teardown: producer-backed survivor proof ---"
  local survivors=0

  # 0. No process owned by this sandbox may remain in any process group this
  #    smoke created. The producer of those groups is the probe wrapper itself,
  #    which recorded each session leader pid. This is the check that covers
  #    detached grandchildren, the class of survivor the old revision leaked 312
  #    of. Ownership is re-validated so a recycled pgid cannot be miscounted.
  local group_alive=0
  local groups=0
  while read -r pgid; do
    [ -n "${pgid}" ] || continue
    groups=$((groups + 1))
    local members
    members="$(owned_members "${pgid}")"
    if [ -n "${members}" ]; then
      group_alive=$((group_alive + 1))
      echo "  SURVIVOR: process group ${pgid} still has members:" >&2
      printf '%s\n' "${members}" >&2
    fi
  done <"${SMOKE_PGIDS}"
  if [ "${group_alive}" -ne 0 ]; then
    survivors=$((survivors + group_alive))
  else
    echo "  ok: 0 of ${groups} probe process groups have surviving sandbox-owned members"
  fi

  # 1. Every process the stubs recorded about themselves must be dead. The
  #    producer here is the stub itself, not this script's bookkeeping.
  local recorded=0
  local alive=0
  while IFS=$'\t' read -r spawn_pid spawn_name _rest; do
    [ -n "${spawn_pid}" ] || continue
    recorded=$((recorded + 1))
    if kill -0 "${spawn_pid}" 2>/dev/null; then
      alive=$((alive + 1))
      echo "  SURVIVOR: stub ${spawn_name} pid ${spawn_pid} still running" >&2
    fi
  done <"${SMOKE_SPAWNED}"
  if [ "${alive}" -ne 0 ]; then
    survivors=$((survivors + alive))
  else
    echo "  ok: 0 of ${recorded} recorded stub processes survived"
  fi

  # 2. No process may still carry this run's marker in its *command line*.
  #    `pgrep -f` matches argv, not the environment, so this does not by itself
  #    prove the absence of listeners or sessions; it catches survivors that
  #    reference the sandbox path. Claim only what it measures.
  local marked
  marked="$(pgrep -f "${SMOKE_MARKER}" 2>/dev/null | grep -v "^$$\$" || true)"
  if [ -n "${marked}" ]; then
    echo "  SURVIVOR: processes still carry the smoke marker in argv: ${marked}" >&2
    survivors=$((survivors + 1))
  else
    echo "  ok: no process carries marker ${SMOKE_MARKER} in its argv"
  fi

  # 3. The real storage root must never have gained a directory for this
  #    smoke's repo id. The id is unique per run, so a hit is proof of escape
  #    and cannot be a false positive from the concurrent live run.
  local escaped
  escaped="$(find "${REAL_STORAGE_ROOT}" -maxdepth 1 -name "*${SMOKE_MARKER}*" \
    2>/dev/null || true)"
  if [ -n "${escaped}" ]; then
    echo "  SURVIVOR: run state escaped into the real storage root: ${escaped}" >&2
    survivors=$((survivors + 1))
  else
    echo "  ok: no run state under ${REAL_STORAGE_ROOT} for this smoke's repo id"
  fi

  # 4. The launcher self-updates by renaming a staged binary over
  #    `process.execPath`, and reaches the GitHub release API through runtime
  #    `fetch()` that no PATH stub can intercept. Two guards, both asserted:
  #    the seeded throttle sentinel must be byte-identical (a cleared throttle
  #    means an update check ran, i.e. the run went online), and no staged
  #    binary may exist. The binary under test is a sandbox copy, so even a
  #    staged update could not have reached the real artifact.
  local sentinel_now
  sentinel_now="$(shasum -a 256 "${UPDATE_CHECK_FILE}" 2>/dev/null |
    cut -d ' ' -f 1)"
  if [ -z "${UPDATE_SENTINEL_SHA}" ]; then
    echo "  ok: teardown ran before the update sentinel was seeded; nothing to check"
  elif [ "${sentinel_now}" != "${UPDATE_SENTINEL_SHA}" ]; then
    echo "  SURVIVOR: auto-update throttle sentinel was rewritten" \
      "(${sentinel_now} != ${UPDATE_SENTINEL_SHA}); the run performed an" \
      "update check and may have gone to the network" >&2
    survivors=$((survivors + 1))
  else
    echo "  ok: auto-update throttle sentinel intact; no update check ran"
  fi
  if [ -e "${SMOKE_HOME}/.cache/loop/update/loop-staged" ]; then
    echo "  SURVIVOR: a staged update binary was downloaded into the sandbox" >&2
    survivors=$((survivors + 1))
  else
    echo "  ok: no staged update binary was downloaded"
  fi

  # Preserve evidence on failure, otherwise remove the sandbox entirely.
  if [ "${survivors}" -ne 0 ]; then
    echo "oss-agent-seat smoke: ${survivors} survivor check(s) failed;" \
      "evidence kept at ${SMOKE_TMP}" >&2
    exit 3
  fi
  # An unchecked `rm -rf` under `set +e` would let a surviving sandbox be
  # reported as a clean teardown. Assert the removal actually happened.
  if ! rm -rf "${SMOKE_TMP}" || [ -e "${SMOKE_TMP}" ]; then
    echo "  SURVIVOR: sandbox could not be removed: ${SMOKE_TMP}" >&2
    exit 3
  fi
  echo "  ok: sandbox removed (${SMOKE_TMP})"
  exit "${exit_code}"
}
# Upgrade the minimal cleanup armed at sandbox creation to the full proof.
trap teardown EXIT INT TERM HUP PIPE

# The launcher's self-update renames a staged binary over `process.execPath`
# (loop-fork/src/loop/update.ts applyBinary/applyStagedUpdateOnStartup). If the
# probes ran the real binary directly, a staged update would overwrite the
# artifact under test - and any shared workspace binary - from inside a test.
# Run a copy instead, and verify the copy is the artifact we were asked to
# certify so the sha256 in the report still means what it says.
SMOKE_BINARY_UNDER_TEST="${SMOKE_TMP}/under-test/loop"
cp "${SMOKE_LOOP_BINARY}" "${SMOKE_BINARY_UNDER_TEST}"
chmod +x "${SMOKE_BINARY_UNDER_TEST}"
COPY_SHA256="$(shasum -a 256 "${SMOKE_BINARY_UNDER_TEST}" | cut -d ' ' -f 1)"
if [ "${COPY_SHA256}" != "${BINARY_SHA256}" ]; then
  echo "oss-agent-seat smoke: sandbox copy ${COPY_SHA256} != ${BINARY_SHA256}" >&2
  exit 2
fi

# PATH stubs shadow curl/wget/nc but cannot block the launcher's runtime
# `fetch()` to the GitHub release API. `shouldThrottle()` reads
# $HOME/.cache/loop/update/last-check.json and skips the check when it is under
# six hours old, and homedir() resolves to the sandbox, so seeding that file
# stops the network call at the source. The timestamp is a sentinel: if the
# throttle ever stops working, `saveCheckTime()` overwrites it and the run
# detects the escape instead of silently going online.
UPDATE_SENTINEL="$(date -u -r "$(($(date +%s) - 60))" +%Y-%m-%dT%H:%M:%S.000Z)"
printf '{"lastCheck":"%s"}\n' "${UPDATE_SENTINEL}" >"${UPDATE_CHECK_FILE}"
UPDATE_SENTINEL_SHA="$(shasum -a 256 "${UPDATE_CHECK_FILE}" | cut -d ' ' -f 1)"


# Non-network stubs. Each records its own pid and argv, then exits immediately.
# `git` is the one real tool the launcher needs (repo identity); everything that
# could spawn a session, a pane, or a socket is shadowed.
for tool in claude codex opencode gemini cursor copilot tmux ssh curl wget nc; do
  cat >"${SMOKE_BIN}/${tool}" <<STUB
#!/usr/bin/env bash
printf '%s\t%s\t%s\n' "\$\$" "${tool}" "\$*" >>"${SMOKE_SPAWNED}"
exit 0
STUB
  chmod +x "${SMOKE_BIN}/${tool}"
done
GIT_BIN="$(command -v git)"
ln -s "${GIT_BIN}" "${SMOKE_BIN}/git"

# A throwaway repo so `resolveRepoId` yields an id unique to this smoke.
(
  cd "${SMOKE_REPO}"
  "${GIT_BIN}" init -q .
  "${GIT_BIN}" -c user.email=smoke@example.invalid -c user.name=smoke \
    commit -q --allow-empty -m "smoke sandbox"
) >/dev/null 2>&1

# Every probe: clean environment, sandbox HOME, sandbox cwd, stubbed PATH, its
# own session/process group, a hard timeout that kills the whole group, and a
# hard cap on how many probes may run at all. Probes are strictly sequential.
bounded() {
  local count
  count=$(($(cat "${SMOKE_PROBE_COUNT_FILE}") + 1))
  printf '%s\n' "${count}" >"${SMOKE_PROBE_COUNT_FILE}"
  if [ "${count}" -gt "${SMOKE_MAX_PROBES}" ]; then
    echo "oss-agent-seat smoke: probe cap ${SMOKE_MAX_PROBES} exceeded" >&2
    kill -TERM $$
    exit 2
  fi
  perl -e '
    use POSIX qw(setsid);
    my $timeout = shift @ARGV;
    my $pgfile  = shift @ARGV;
    my $pid = fork();
    die "fork failed: $!" unless defined $pid;
    if ($pid == 0) { setsid(); exec @ARGV; exit 127; }
    if (open(my $fh, ">>", $pgfile)) { print $fh "$pid\n"; close $fh; }
    my $timed_out = 0;
    local $SIG{ALRM} = sub { $timed_out = 1; kill("TERM", -$pid); };
    alarm $timeout;
    waitpid($pid, 0);
    my $status = $?;
    alarm 0;
    kill("KILL", -$pid);
    exit(124) if $timed_out;
    exit($status >> 8);
  ' "${SMOKE_PROBE_TIMEOUT_S}" "${SMOKE_PGIDS}" \
    env -i \
    HOME="${SMOKE_HOME}" \
    PATH="${SMOKE_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
    TMPDIR="${SMOKE_TMP}/tmp" \
    TERM=dumb \
    LOOP_SMOKE_MARKER="${SMOKE_MARKER}" \
    /bin/sh -c 'cd "$1" && shift && exec "$@"' _ "${SMOKE_REPO}" "$@"
}

# --- instrument check: prove isolation before using launch-shaped argv --------
#
# Nothing below may run until the binary is observed to resolve run state into
# the sandbox. Absence of evidence must abort, not proceed: a silent failure
# here is exactly how the previous revision escaped.
echo "--- isolation instrument check ---"
# Drive one real launch. This is the exact code path that caused the incident:
# the launcher resolves run storage, writes run config, and spawns an agent.
# Here the agent is a stub, so the stub itself is the producer of the evidence -
# it records the argv it was handed. If that argv points into the sandbox HOME,
# the isolation lever is proven to hold for this binary. Asserting on stub argv
# rather than leftover files also survives the launcher cleaning up after itself.
bounded "${SMOKE_BINARY_UNDER_TEST}" "isolation instrument check" \
  --agent claude --proof "${SMOKE_MARKER}" >/dev/null 2>&1 || true

if ! grep -qF "${SMOKE_HOME}" "${SMOKE_SPAWNED}" 2>/dev/null; then
  echo "oss-agent-seat smoke: ABORT - no stub was invoked with run state under" \
    "the sandbox HOME (${SMOKE_HOME}). Isolation is unproven, so launch-shaped" \
    "probes are refused. Nothing further ran." >&2
  echo "recorded stub invocations:" >&2
  cat "${SMOKE_SPAWNED}" >&2
  exit 2
fi
if find "${REAL_STORAGE_ROOT}" -maxdepth 1 -name "*${SMOKE_MARKER}*" 2>/dev/null |
  grep -q .; then
  echo "oss-agent-seat smoke: ABORT - run state reached the real storage root." >&2
  exit 2
fi
pass "the launcher resolved run storage into the sandbox HOME"
pass "real storage root ${REAL_STORAGE_ROOT} gained nothing for this repo id"

echo "--- the OSS seat launches OpenCode with the documented contract ---"
# Same real-launch path, now on the OSS seat. The `opencode` stub records the
# argv the adapter built, so these assert the shipped binary's behaviour rather
# than the TypeScript source's intent.
#
# The spawn log is append-only because teardown's survivor proof reads it, so
# scope a check to one probe by reading only the lines that probe appended.
spawned_since() {
  tail -n "+$(($1 + 1))" "${SMOKE_SPAWNED}" 2>/dev/null || true
}
spawn_lines() {
  wc -l <"${SMOKE_SPAWNED}" 2>/dev/null | tr -d ' '
}

OSS_MARK="$(spawn_lines)"
bounded "${SMOKE_BINARY_UNDER_TEST}" "oss seat contract check" \
  --oss-only --proof "${SMOKE_MARKER}" >/dev/null 2>&1 || true
OSS_ARGV="$(spawned_since "${OSS_MARK}" | grep -F "opencode" || true)"
if [ -z "${OSS_ARGV}" ]; then
  fail "the OSS seat never invoked opencode"
else
  for token in "run" "--format json" "openrouter/z-ai/glm-5.2"; do
    if printf '%s' "${OSS_ARGV}" | grep -qF -- "${token}"; then
      pass "opencode argv carries ${token}"
    else
      fail "opencode argv is missing ${token}: ${OSS_ARGV}"
    fi
  done
fi

echo "--- an overridden OSS model reaches OpenCode unrewritten ---"
OSS_CUSTOM_MODEL="self-hosted.vllm/Org_Name/Model-v2.1:awq@2026-01"
MODEL_MARK="$(spawn_lines)"
bounded "${SMOKE_BINARY_UNDER_TEST}" "oss model passthrough check" \
  --oss-only --oss-model "${OSS_CUSTOM_MODEL}" --proof "${SMOKE_MARKER}" \
  >/dev/null 2>&1 || true
if spawned_since "${MODEL_MARK}" | grep -qF -- "${OSS_CUSTOM_MODEL}"; then
  pass "arbitrary model id reaches opencode verbatim: ${OSS_CUSTOM_MODEL}"
else
  fail "arbitrary model id did not reach opencode verbatim: $(spawned_since "${MODEL_MARK}")"
fi

# --- checks -----------------------------------------------------------------

HELP_TEXT="$(bounded "${SMOKE_BINARY_UNDER_TEST}" --help 2>&1 || true)"

echo "--- help advertises the OSS seat ---"
for token in "--oss-only" "--oss-model" "--oss-reviewer-model" "oss-loop" \
  "openrouter/z-ai/glm-5.2" "LOOP_OSS_RELEASE_AUTHORITY"; do
  if printf '%s' "${HELP_TEXT}" | grep -qF -- "${token}"; then
    pass "help mentions ${token}"
  else
    fail "help is missing ${token}"
  fi
done

echo "--- help no longer advertises retired seats ---"
# Line-oriented grep misses wrapped text, so flatten before asserting absence.
HELP_FLAT="$(printf '%s' "${HELP_TEXT}" | tr '\n' ' ')"
for token in "--gemini-only" "--cursor-only" "--copilot-only" \
  "--gemini-model" "--cursor-model" "--copilot-model" \
  "gemini-loop" "cursor-loop" "copilot-loop"; do
  if printf '%s' "${HELP_FLAT}" | grep -qF -- "${token}"; then
    fail "help still advertises retired ${token}"
  else
    pass "help omits retired ${token}"
  fi
done

echo "--- retired flags fail closed naming oss ---"
for flag in "--gemini-only" "--cursor-only" "--copilot-only"; do
  status=0
  output="$(bounded "${SMOKE_BINARY_UNDER_TEST}" "${flag}" 2>&1)" || status=$?
  if [ "${status}" -eq 0 ]; then
    fail "${flag} exited 0 instead of failing closed"
  elif printf '%s' "${output}" | tr '\n' ' ' | grep -q "is retired"; then
    if printf '%s' "${output}" | tr '\n' ' ' | grep -q "oss"; then
      pass "${flag} fails closed naming oss (exit ${status})"
    else
      fail "${flag} fails closed without naming oss"
    fi
  else
    fail "${flag} failed without a migration message"
  fi
done

echo "--- retired model flags fail closed ---"
for flag in "--gemini-model" "--cursor-model" "--copilot-model" \
  "--gemini-reviewer-model" "--cursor-reviewer-model" \
  "--copilot-reviewer-model"; do
  status=0
  output="$(bounded "${SMOKE_BINARY_UNDER_TEST}" "${flag}" "some-model" 2>&1)" || status=$?
  if [ "${status}" -eq 0 ]; then
    fail "${flag} exited 0 instead of failing closed"
  elif printf '%s' "${output}" | tr '\n' ' ' | grep -q "is retired"; then
    pass "${flag} fails closed (exit ${status})"
  else
    fail "${flag} failed without a migration message"
  fi
done

echo "--- retired agent values fail closed ---"
for selector in "--agent" "--pair-with" "--reviewer" "--review" "--review-plan"; do
  for retired in gemini cursor copilot; do
    status=0
    output="$(bounded "${SMOKE_BINARY_UNDER_TEST}" "${selector}" "${retired}" --proof x 2>&1)" ||
      status=$?
    if [ "${status}" -eq 0 ]; then
      fail "${selector} ${retired} exited 0 instead of failing closed"
    elif printf '%s' "${output}" | tr '\n' ' ' | grep -q "is retired"; then
      pass "${selector} ${retired} fails closed (exit ${status})"
    else
      fail "${selector} ${retired} failed without a migration message"
    fi
  done
done

echo "--- bridge source topology names oss and omits retired seats ---"
BRIDGE_USAGE="$(bounded "${SMOKE_BINARY_UNDER_TEST}" __bridge-mcp 2>&1 || true)"
BRIDGE_FLAT="$(printf '%s' "${BRIDGE_USAGE}" | tr '\n' ' ')"
if printf '%s' "${BRIDGE_FLAT}" | grep -qF "claude|codex|oss|supervisor"; then
  pass "bridge usage lists claude|codex|oss|supervisor"
else
  fail "bridge usage does not list the OSS topology: ${BRIDGE_USAGE}"
fi
for retired in gemini cursor copilot; do
  if printf '%s' "${BRIDGE_FLAT}" | grep -qF "${retired}"; then
    fail "bridge usage still lists retired ${retired}"
  else
    pass "bridge usage omits retired ${retired}"
  fi
done

HOOK_USAGE="$(bounded "${SMOKE_BINARY_UNDER_TEST}" __hook-emit 2>&1 || true)"
HOOK_FLAT="$(printf '%s' "${HOOK_USAGE}" | tr '\n' ' ')"
if printf '%s' "${HOOK_FLAT}" | grep -qF "claude|codex|oss"; then
  pass "hook usage lists claude|codex|oss"
else
  fail "hook usage does not list the OSS topology: ${HOOK_USAGE}"
fi

echo "--- an arbitrary provider/model id is accepted verbatim ---"
# The parser must not rewrite or validate the identifier; only OpenCode owns
# provider resolution. A missing prompt still stops the run, so assert on the
# absence of a model-shaped complaint rather than on exit status alone.
for model in "openrouter/z-ai/glm-5.2" "ollama/qwen3-coder:480b" \
  "self-hosted.vllm/Org_Name/Model-v2.1:awq@2026-01"; do
  output="$(bounded "${SMOKE_BINARY_UNDER_TEST}" --oss-model "${model}" --help 2>&1 || true)"
  if printf '%s' "${output}" | tr '\n' ' ' | grep -qi "invalid --oss-model"; then
    fail "model identifier rejected: ${model}"
  else
    pass "model identifier accepted verbatim: ${model}"
  fi
done
status=0
bounded "${SMOKE_BINARY_UNDER_TEST}" "--oss-model=" --proof x >/dev/null 2>&1 || status=$?
if [ "${status}" -eq 0 ]; then
  fail "an empty --oss-model was accepted"
else
  pass "an empty --oss-model fails closed (exit ${status})"
fi

echo
echo "oss-agent-seat smoke: $(cat "${SMOKE_PROBE_COUNT_FILE}") probe(s)," \
  "cap ${SMOKE_MAX_PROBES}"
if [ "${FAILURES}" -ne 0 ]; then
  echo "oss-agent-seat smoke: ${FAILURES} failure(s)" >&2
  exit 1
fi
echo "oss-agent-seat smoke: all checks passed against ${BINARY_SHA256}"
