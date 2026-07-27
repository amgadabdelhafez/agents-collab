#!/usr/bin/env bash
# .claude/hooks/deny-protected-paths.sh
#
# PreToolUse hook. Blocks file-editing tools from writing the files that govern
# agent behaviour, so a run cannot silently loosen its own constraints.
#
# Wired up by .claude/settings.json (project scope). Exit 2 tells Claude Code to
# block the call and hand the stderr text back to the model.
#
# This is the *prevention* half. The *detection* half is
# scripts/check-protected-paths.sh, which is what the merge gate actually runs —
# a hook only covers Write/Edit-shaped tools, never `bash -c 'sed -i ...'`.
#
# Escape hatch: export ALLOW_PROTECTED_PATHS=1 in the session that legitimately
# needs to edit these files.

set -euo pipefail

if [ "${ALLOW_PROTECTED_PATHS:-0}" = "1" ]; then
  exit 0
fi

payload="$(cat)"

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}" \
PAYLOAD="${payload}" \
python3 - <<'PY'
import json
import os
import re
import sys

PROTECTED = [
    r"(^|/)\.claude/settings(\.local)?\.json$",
    r"(^|/)\.claude/hooks/",
    r"(^|/)\.harness/hooks/",
    r"(^|/)\.github/workflows/",
    r"(^|/)CLAUDE\.md$",
    r"(^|/)AGENTS\.md$",
]

try:
    event = json.loads(os.environ["PAYLOAD"])
except (KeyError, ValueError):
    sys.exit(0)  # unparseable event: never block on our own bug

tool_input = event.get("tool_input") or {}
candidates = [
    tool_input.get("file_path"),
    tool_input.get("notebook_path"),
    tool_input.get("path"),
]

project_dir = os.path.realpath(os.environ["PROJECT_DIR"])
for raw in candidates:
    if not raw:
        continue
    target = os.path.realpath(os.path.join(project_dir, raw))
    rel = os.path.relpath(target, project_dir)
    for pattern in PROTECTED:
        if re.search(pattern, rel):
            sys.stderr.write(
                f"BLOCKED: {rel} is a protected path.\n"
                "Files that govern agent behaviour (.claude/settings*.json, "
                "hook scripts, CLAUDE.md, AGENTS.md, CI workflows) are not "
                "agent-writable in this repo.\n"
                "Propose the change to the supervisor instead, or re-run the "
                "session with ALLOW_PROTECTED_PATHS=1 if a human decided on it.\n"
            )
            sys.exit(2)

sys.exit(0)
PY
