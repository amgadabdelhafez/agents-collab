#!/usr/bin/env bash
# End-to-end test for the project PreToolUse hooks.
#
# Feeds each hook the exact JSON payload Claude Code writes to a PreToolUse
# hook's stdin and asserts the exit code (0 = allow, 2 = deny).
#
# Run from anywhere:  scripts/hooks/test-hooks.sh
set -uo pipefail

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HOOK_DIR/../.." && pwd)"
ADD_HOOK="$HOOK_DIR/block-bulk-git-add.py"
PATH_HOOK="$HOOK_DIR/guard-protected-paths.py"

pass=0
fail=0

# check <hook> <expected-exit> <label> <payload-json>
check() {
  local hook="$1" expected="$2" label="$3" payload="$4"
  local out rc
  out="$(printf '%s' "$payload" | "$hook" 2>&1)"
  rc=$?
  if [ "$rc" -eq "$expected" ]; then
    pass=$((pass + 1))
    printf 'ok    exit=%s  %s\n' "$rc" "$label"
  else
    fail=$((fail + 1))
    printf 'FAIL  exit=%s want=%s  %s\n' "$rc" "$expected" "$label"
    printf '      %s\n' "$out" | head -3
  fi
}

bash_payload() {
  python3 -c 'import json,sys; print(json.dumps({"session_id":"test","hook_event_name":"PreToolUse","cwd":sys.argv[1],"tool_name":"Bash","tool_input":{"command":sys.argv[2],"description":"t"}}))' "$ROOT" "$1"
}

file_payload() {
  python3 -c 'import json,sys; print(json.dumps({"session_id":"test","hook_event_name":"PreToolUse","cwd":sys.argv[1],"tool_name":sys.argv[2],"tool_input":{"file_path":sys.argv[3],"content":"x"}}))' "$ROOT" "$1" "$2"
}

echo "=== block-bulk-git-add.py :: must DENY (exit 2) ==="
for cmd in \
  'git add -A' \
  'git add --all' \
  'git add .' \
  'git add ./' \
  'git add -A .' \
  'git add -Av' \
  'git add :/' \
  'git stage -A' \
  'git commit -a -m "wip"' \
  'git commit -am "wip"' \
  'git commit --all -m "wip"' \
  'cd loop-fork && git add -A' \
  'git status --short; git add -A; git commit -m x' \
  'git -C /some/worktree add -A' \
  'git add   -A   # sweep' \
  'GIT_AUTHOR_NAME=x git add .'
do
  check "$ADD_HOOK" 2 "deny: $cmd" "$(bash_payload "$cmd")"
done

echo
echo "=== block-bulk-git-add.py :: must ALLOW (exit 0) ==="
for cmd in \
  'git add scripts/hooks/block-bulk-git-add.py' \
  'git add specs/constitution.md AGENTS.md' \
  'git add -p scripts/verify.sh' \
  'git add -u' \
  'git add -- path/with-dash.ts' \
  'git commit -m "explicit paths only"' \
  'git commit --amend --no-edit' \
  'git status --short' \
  'git diff --stat' \
  'ls -A' \
  'bun test' \
  'echo "git add -A is what we do not do"' \
  'grep -rn "git add -A" docs/'
do
  check "$ADD_HOOK" 0 "allow: $cmd" "$(bash_payload "$cmd")"
done

echo
echo "=== guard-protected-paths.py :: must DENY (exit 2) ==="
check "$PATH_HOOK" 2 "deny: Write .claude/settings.json"        "$(file_payload Write "$ROOT/.claude/settings.json")"
check "$PATH_HOOK" 2 "deny: Edit .claude/settings.json (rel)"   "$(file_payload Edit ".claude/settings.json")"
check "$PATH_HOOK" 2 "deny: Write .claude/settings.local.json"  "$(file_payload Write "$ROOT/.claude/settings.local.json")"
check "$PATH_HOOK" 2 "deny: Write .gitignore"                   "$(file_payload Write "$ROOT/.gitignore")"
check "$PATH_HOOK" 2 "deny: Edit a hook script (self-disarm)"   "$(file_payload Edit "$ROOT/scripts/hooks/block-bulk-git-add.py")"
check "$PATH_HOOK" 2 "deny: Edit protected-paths.conf"          "$(file_payload Edit "$ROOT/scripts/hooks/protected-paths.conf")"
check "$PATH_HOOK" 2 "deny: Write ~/.claude/settings.json"      "$(file_payload Write "$HOME/.claude/settings.json")"
check "$PATH_HOOK" 2 "deny: Write ~/.codex/config.toml"         "$(file_payload Write "$HOME/.codex/config.toml")"
check "$PATH_HOOK" 2 "deny: Write ~/.codex/AGENTS.md"           "$(file_payload Write "$HOME/.codex/AGENTS.md")"
check "$PATH_HOOK" 2 "deny: bash redirect into settings.json"   "$(bash_payload "echo '{}' > $ROOT/.claude/settings.json")"
check "$PATH_HOOK" 2 "deny: bash append into .gitignore"        "$(bash_payload "echo 'foo' >> .gitignore")"
check "$PATH_HOOK" 2 "deny: sed -i on protected-paths.conf"     "$(bash_payload "sed -i '' '/gitignore/d' scripts/hooks/protected-paths.conf")"
check "$PATH_HOOK" 2 "deny: rm the guard"                       "$(bash_payload "rm scripts/hooks/guard-protected-paths.py")"
check "$PATH_HOOK" 2 "deny: tee into user settings"             "$(bash_payload "echo x | tee ~/.claude/settings.json")"

echo
echo "=== guard-protected-paths.py :: must ALLOW (exit 0) ==="
check "$PATH_HOOK" 0 "allow: Edit specs/constitution.md"        "$(file_payload Edit "$ROOT/specs/constitution.md")"
check "$PATH_HOOK" 0 "allow: Edit CLAUDE.md"                    "$(file_payload Edit "$ROOT/CLAUDE.md")"
check "$PATH_HOOK" 0 "allow: Write in loop-fork/"               "$(file_payload Write "$ROOT/loop-fork/v2/kit/scripts/loop-prompt.sh")"
check "$PATH_HOOK" 0 "allow: read settings.json"                "$(bash_payload "cat .claude/settings.json")"
check "$PATH_HOOK" 0 "allow: grep settings.json"                "$(bash_payload "grep -n hooks .claude/settings.json")"
check "$PATH_HOOK" 0 "allow: diff settings.json to /tmp"        "$(bash_payload "git diff .claude/settings.json > /tmp/out.diff")"
check "$PATH_HOOK" 0 "allow: write elsewhere"                   "$(bash_payload "echo hi > /tmp/scratch.txt")"
check "$PATH_HOOK" 0 "allow: Write outside the repo"            "$(file_payload Write "/tmp/anything.json")"

echo
printf '%s\n' "-----------------------------------------"
printf 'pass=%d fail=%d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
