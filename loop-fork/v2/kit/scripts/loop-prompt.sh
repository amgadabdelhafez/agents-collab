#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: loop-prompt.sh <task-id> <slug> --slice <text> [--proof <text>] [--test-command <cmd>] [--allow-done] [--force]
USAGE
  exit 2
}

normalize_test_command() {
  local command_text="$1"
  local rest=""
  if [[ "${command_text}" == "pytest" || "${command_text}" == pytest\ * ]]; then
    rest="${command_text#pytest}"
    if [[ -x "venv/bin/python" ]]; then
      printf 'venv/bin/python -m pytest%s' "${rest}"
      return
    fi
    if [[ -x ".venv/bin/python" ]]; then
      printf '.venv/bin/python -m pytest%s' "${rest}"
      return
    fi
  fi
  printf '%s' "${command_text}"
}

repo_has_session_detail_version() {
  if command -v rg >/dev/null 2>&1; then
    rg -q "SESSION_DETAIL_VERSION" \
      --glob '!runs/**' \
      --glob '!specs/**' \
      --glob '!reports/**' \
      --glob '!node_modules/**' \
      --glob '!v2/kit/**' \
      . 2>/dev/null
    return $?
  fi

  for dir in src dashboard tests; do
    [[ -d "${dir}" ]] || continue
    if grep -R "SESSION_DETAIL_VERSION" "${dir}" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

[[ $# -ge 2 ]] || usage

TASK_ID="$1"
SLUG="$2"
shift 2

SLICE=""
PROOF=""
TEST_COMMAND=""
ALLOW_DONE=0
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slice)
      [[ $# -ge 2 ]] || usage
      SLICE="$2"
      shift 2
      ;;
    --proof)
      [[ $# -ge 2 ]] || usage
      PROOF="$2"
      shift 2
      ;;
    --test-command)
      [[ $# -ge 2 ]] || usage
      TEST_COMMAND="$2"
      shift 2
      ;;
    --allow-done)
      ALLOW_DONE=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage
      ;;
  esac
done

case "${TASK_ID}" in
  *[!a-z0-9-]*|""|-*) echo "error: task id must be kebab-case" >&2; exit 2 ;;
esac
case "${SLUG}" in
  *[!a-z0-9-]*|""|-*) echo "error: slug must be kebab-case" >&2; exit 2 ;;
esac
[[ -n "${SLICE}" ]] || {
  echo "error: --slice is required" >&2
  usage
}

RUN_DIR="runs/${TASK_ID}"
PLAN="${RUN_DIR}/plan.md"
OUT_DIR="${RUN_DIR}/loop-slices"
PROMPT="${OUT_DIR}/${SLUG}.md"

[[ -d "${RUN_DIR}" ]] || {
  echo "error: missing run dir: ${RUN_DIR}" >&2
  exit 1
}
[[ -f "${PLAN}" ]] || {
  echo "error: missing harness plan: ${PLAN}" >&2
  exit 1
}
if [[ -f "${PROMPT}" && "${FORCE}" -ne 1 ]]; then
  echo "error: loop prompt already exists: ${PROMPT}" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"

done_rule="Do not run \`./harness done\`; this prompt is for one slice of the active task."
if [[ "${ALLOW_DONE}" -eq 1 ]]; then
  done_rule="Run \`./harness done\` only after the full active Harness task is complete and \`./harness stop-gate --json\` passes."
fi

proof_block="- Run concrete verification through \`./harness verify unit -- <test command>\`."
if [[ -n "${TEST_COMMAND}" ]]; then
  NORMALIZED_TEST_COMMAND="$(normalize_test_command "${TEST_COMMAND}")"
  proof_block="- Run \`./harness verify unit -- ${NORMALIZED_TEST_COMMAND}\`."
fi
if [[ -n "${PROOF}" ]]; then
  proof_block="${proof_block}
- ${PROOF}"
fi

cache_review_notes="- Prefer repo-local test interpreters. Bare \`pytest\` proof commands are normalized to \`venv/bin/python -m pytest\` or \`.venv/bin/python -m pytest\` when that interpreter exists.
- If this slice changes cached or schema-versioned payloads, bump the matching version constant or explicitly note why no bump is needed."
if repo_has_session_detail_version; then
  cache_review_notes="${cache_review_notes}
- This repo defines \`SESSION_DETAIL_VERSION\`: bump it if classifier, metrics, retrospect, or other fields are written into cached session detail payloads. If changes stay on non-cached rows, leave it unchanged and note why."
fi

cat > "${PROMPT}" <<EOF
# Loop Slice Prompt: ${SLUG}

Use this file as the \`loop --prompt\` input. Do not pass equivalent plain text
to \`loop\`, because plain text makes loop create a root \`PLAN.md\`.

## Harness Context

- Active task: \`${TASK_ID}\`
- Canonical Harness plan: \`${PLAN}\`
- This slice prompt: \`${PROMPT}\`

## Slice Scope

${SLICE}

## Agent Roles

- Codex is the primary implementer.
- Claude is the reviewer, bridge manager, and test-pressure agent.
- Harness is the source of truth for task state and evidence.

## Rules

- Read \`HARNESS.md\`, \`${PLAN}\`, and the latest files in \`${RUN_DIR}/memory/\`.
- Treat \`${PLAN}\` as the canonical parent plan.
- Treat this file as the loop execution plan for this slice only.
- Do not create, replace, or rely on root \`PLAN.md\`.
- Keep changes scoped to the slice.
- Update \`${RUN_DIR}/task-log.md\` with what changed and why.
- Add checkpoints with \`./harness checkpoint "<topic>"\` after meaningful decisions.
- Run \`./harness preflight --json\` before stopping.
- ${done_rule}

## Review Checks

${cache_review_notes}

## Proof Criteria

${proof_block}
EOF

cat <<EOF
${PROMPT}

Run with:

TASK=\$(cat .harness/current-task)
loop --tmux --agent claude --review codex --review-plan none \\
  --prompt ${PROMPT} \\
  --proof "Follow the Proof Criteria in ${PROMPT}. Do not treat root PLAN.md as authoritative."
EOF
