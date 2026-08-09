#!/usr/bin/env bash
set -euo pipefail

ROOT=$(mktemp -d /private/tmp/loop-t15.XXXXXX)
cleanup() {
  rm -rf "${ROOT}"
}
trap cleanup EXIT INT TERM

RUN_DIR="${ROOT}/home/.loop/runs/agents-collab-fa87e8608224/1"
FAKE_BIN="${ROOT}/bin"
TRACE="${ROOT}/tmux-trace.txt"
mkdir -p "${RUN_DIR}" "${FAKE_BIN}" "${ROOT}/tmp" "${ROOT}/tmux"
cp tests/fixtures/tmux-socket-normalization/manifest-new.json \
  "${RUN_DIR}/manifest.json"
cp runs/d028-installed-forward-compat/artifacts/tmux "${FAKE_BIN}/tmux"
chmod +x "${FAKE_BIN}/tmux"
: > "${TRACE}"

echo "installed_version=$(/Users/amgad/.local/bin/loop --version)"
echo "installed_sha256=$(shasum -a 256 /Users/amgad/.local/bin/loop | awk '{print $1}')"
echo "source_fixture_sha256=$(shasum -a 256 tests/fixtures/tmux-socket-normalization/manifest-new.json | awk '{print $1}')"
echo "copied_fixture_sha256_before=$(shasum -a 256 "${RUN_DIR}/manifest.json" | awk '{print $1}')"

set +e
OUTPUT=$(env -i \
  HOME="${ROOT}/home" \
  LANG=C.UTF-8 \
  LOGNAME=loop-t15 \
  LOOP_T15_TMUX_TRACE="${TRACE}" \
  PATH="${FAKE_BIN}:/Users/amgad/.bun/bin:/usr/bin:/bin" \
  SHELL=/bin/zsh \
  TERM=xterm-256color \
  TMPDIR="${ROOT}/tmp" \
  TMUX_TMPDIR="${ROOT}/tmux" \
  USER=loop-t15 \
  /Users/amgad/.local/bin/loop governess doctor 1 2>&1)
STATUS=$?
set -e

printf 'doctor_exit_code=%s\n' "${STATUS}"
printf '%s\n' "doctor_output_begin" "${OUTPUT}" "doctor_output_end"
echo "tmux_trace_begin"
sed "s#${ROOT}#<isolated-root>#g" "${TRACE}"
echo "tmux_trace_end"
echo "copied_fixture_sha256_after=$(shasum -a 256 "${RUN_DIR}/manifest.json" | awk '{print $1}')"
echo "isolated_files_begin"
find "${ROOT}" -type f -print | sed "s#${ROOT}#<isolated-root>#g" | sort
echo "isolated_files_end"
echo "isolated_home_file_count=$(find "${ROOT}/home" -type f | wc -l | tr -d ' ')"
echo "isolated_tmux_socket_count=$(find "${ROOT}/tmux" -type s | wc -l | tr -d ' ')"

test "${STATUS}" -eq 0
grep -Fq '"manifest": true' <<< "${OUTPUT}"
test "$(shasum -a 256 "${RUN_DIR}/manifest.json" | awk '{print $1}')" = \
  "$(shasum -a 256 tests/fixtures/tmux-socket-normalization/manifest-new.json | awk '{print $1}')"
test "$(find "${ROOT}/home" -type f | wc -l | tr -d ' ')" -eq 1
test "$(find "${ROOT}/tmux" -type s | wc -l | tr -d ' ')" -eq 0
test -s "${TRACE}"
echo "verdict=PASS"
