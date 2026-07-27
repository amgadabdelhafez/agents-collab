#!/usr/bin/env bash
# Reap git worktrees that are provably safe to remove.
#
# A worktree is reaped only if ALL of these hold:
#   1. its branch is fully merged into the integration branch (default: main)
#   2. its working tree is clean (no modified AND no untracked files)
#   3. no running process has its cwd inside it
#   4. it is not the primary worktree
#
# Anything failing a check is reported and left alone. Nothing is ever
# force-removed: uncommitted work is surfaced for salvage, not discarded.
#
# Written 2026-07-27 after a hygiene pass found a *live* loop worktree and two
# same-day documents sitting uncommitted in worktrees that a naive sweep would
# have deleted. Checks 2 and 3 exist because of those two findings — do not
# remove them.
#
# Usage:
#   .github/scripts/reap-worktrees.sh            # dry run — report only
#   .github/scripts/reap-worktrees.sh --apply    # actually remove
#   .github/scripts/reap-worktrees.sh --apply --base develop

set -uo pipefail

BASE=main
APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --base) shift; BASE="${1:-main}" ;;
  esac
  shift
done

cd "$(git rev-parse --show-toplevel)" || exit 1
PRIMARY="$(git rev-parse --show-toplevel)"

reaped=0; skipped=0; mb=0

while IFS='|' read -r p b; do
  [ -z "$p" ] && continue
  [ "$p" = "$PRIMARY" ] && continue

  if [ ! -d "$p" ]; then
    echo "  stale-registration  $p   (git worktree prune will clear)"
    continue
  fi

  short="${b#refs/heads/}"

  if ! git merge-base --is-ancestor "$b" "$BASE" 2>/dev/null; then
    ahead=$(git rev-list --count "$BASE..$b" 2>/dev/null || echo '?')
    echo "  KEEP unmerged       ${p##*/}  [$short, $ahead ahead of $BASE]"
    skipped=$((skipped + 1)); continue
  fi

  dirty=$(git -C "$p" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  if [ "$dirty" != "0" ]; then
    echo "  KEEP dirty($dirty)      ${p##*/}  [$short] — salvage before reaping:"
    git -C "$p" status --porcelain 2>/dev/null | head -3 | sed 's|^|        |'
    skipped=$((skipped + 1)); continue
  fi

  if lsof -a -d cwd -- "$p" >/dev/null 2>&1; then
    echo "  KEEP in-use         ${p##*/}  [$short] — a process is running in it"
    skipped=$((skipped + 1)); continue
  fi

  sz=$(du -sm "$p" 2>/dev/null | cut -f1); sz=${sz:-0}
  if [ "$APPLY" = "1" ]; then
    if git worktree remove "$p" 2>/dev/null; then
      echo "  reaped (${sz}MB)      ${p##*/}  [$short]"
      reaped=$((reaped + 1)); mb=$((mb + sz))
    else
      echo "  FAILED              ${p##*/}  [$short]"
    fi
  else
    echo "  would reap (${sz}MB)  ${p##*/}  [$short]"
    reaped=$((reaped + 1)); mb=$((mb + sz))
  fi
done < <(git worktree list --porcelain | awk '/^worktree /{p=$2} /^branch /{print p"|"$2}')

[ "$APPLY" = "1" ] && git worktree prune

echo
if [ "$APPLY" = "1" ]; then
  echo "  reaped $reaped worktrees (~${mb}MB), kept $skipped"
else
  echo "  $reaped reapable (~${mb}MB), $skipped kept — re-run with --apply to remove"
fi
