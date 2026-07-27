#!/usr/bin/env bash
# scripts/check-protected-paths.sh
#
# Denylist gate: refuse a change that touches the files which govern how agents
# behave. An agent run may edit product code freely; it may not quietly rewrite
# its own leash.
#
# Protected (any depth in the tree):
#   **/.claude/settings.json, **/.claude/settings.local.json
#   **/.claude/hooks/**, **/.harness/hooks/**
#   **/CLAUDE.md, **/AGENTS.md
#   **/.github/workflows/**
#
# Deliberately NOT protected: loop-fork/src/loop/hooks/*.ts is product source
# that agents are supposed to edit. The patterns below are anchored so that
# path never matches.
#
# Usage:
#   scripts/check-protected-paths.sh                 # working tree + index vs HEAD
#   scripts/check-protected-paths.sh --staged        # index only (pre-commit)
#   scripts/check-protected-paths.sh --range A..B    # a commit range (pre-push/CI)
#
# Bypass (for the human who actually means it):
#   ALLOW_PROTECTED_PATHS=1 scripts/check-protected-paths.sh
#
# Exit codes: 0 clean, 1 a protected path was touched, 2 usage error.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

MODE="worktree"
RANGE=""
case "${1:-}" in
  ""|--worktree) MODE="worktree" ;;
  --staged) MODE="staged" ;;
  --range)
    MODE="range"
    RANGE="${2:-}"
    [ -n "${RANGE}" ] || { echo "check-protected-paths: --range needs A..B" >&2; exit 2; }
    ;;
  -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
  *) echo "check-protected-paths: unknown argument: $1" >&2; exit 2 ;;
esac

# One extended-regex per line, matched against repo-relative paths.
PROTECTED='(^|/)\.claude/settings(\.local)?\.json$
(^|/)\.claude/hooks/
(^|/)\.harness/hooks/
(^|/)\.github/workflows/
(^|/)CLAUDE\.md$
(^|/)AGENTS\.md$'

case "${MODE}" in
  worktree)
    changed="$(
      { git diff --name-only HEAD;
        git ls-files --others --exclude-standard; } | sort -u
    )"
    scope_desc="working tree + index vs HEAD"
    ;;
  staged)
    changed="$(git diff --cached --name-only | sort -u)"
    scope_desc="staged changes"
    ;;
  range)
    changed="$(git diff --name-only "${RANGE}" | sort -u)"
    scope_desc="range ${RANGE}"
    ;;
esac

hits=""
if [ -n "${changed}" ]; then
  hits="$(printf '%s\n' "${changed}" | grep -E "${PROTECTED}" || true)"
fi

if [ -z "${hits}" ]; then
  echo "protected-paths: OK (${scope_desc})"
  exit 0
fi

if [ "${ALLOW_PROTECTED_PATHS:-0}" = "1" ]; then
  echo "protected-paths: OVERRIDDEN by ALLOW_PROTECTED_PATHS=1 (${scope_desc})"
  printf '%s\n' "${hits}" | sed 's/^/  ! /'
  exit 0
fi

{
  echo "PROTECTED PATHS TOUCHED — ${scope_desc}"
  printf '%s\n' "${hits}" | sed 's/^/  - /'
  echo
  echo "These files govern agent behaviour and are not agent-writable."
  echo "If a human decided on this change, re-run with ALLOW_PROTECTED_PATHS=1."
} >&2
exit 1
