#!/usr/bin/env python3
"""PreToolUse hook: refuse writes to protected configuration paths.

WHY THIS EXISTS
---------------
The files that decide what an agent is allowed to do must not be editable by
the agent they govern. That includes the hook registration itself and the
hook scripts -- otherwise the first move around any guard is to delete the
guard. It also includes the user-level Claude/Codex configuration, which the
founder hardened on 2026-07-27 and put on a deny list.

WHAT IT COVERS
--------------
The path list lives in `protected-paths.conf` beside this script, so it is
versioned with the repo and reviewable in a diff.

  * file tools : Write / Edit / MultiEdit / NotebookEdit -- the target path
  * Bash       : redirect targets (`>`, `>>`) and the arguments of commands
                 that mutate files (tee, sed -i, cp, mv, rm, truncate, ...)

Reads are never blocked. `grep .claude/settings.json` and
`git diff .claude/settings.json > /tmp/out` both pass; only writes that land
ON a protected path are denied.

CONTRACT
--------
stdin  : PreToolUse hook JSON (tool_name, tool_input, cwd, ...)
exit 0 : allow
exit 2 : deny; stderr is fed back to the agent as the reason
other  : non-blocking error (Claude Code surfaces stderr, tool proceeds)

Self-test: scripts/hooks/test-hooks.sh
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PATTERN_FILE = HERE / "protected-paths.conf"

# Commands whose non-flag arguments are (or may be) write destinations.
MUTATING_COMMANDS = {
    "tee", "cp", "mv", "rm", "unlink", "truncate", "install", "dd", "shred",
    "chmod", "chown", "ln", "touch", "patch", "gsed", "ex",
}
# Commands that only mutate when given an in-place flag.
INPLACE_COMMANDS = {"sed", "perl", "ruby", "awk"}
INPLACE_FLAGS = re.compile(r"^-{1,2}i")

REDIRECT = re.compile(r"(?:^|[\s;&|])\d*>>?\s*(\"[^\"]+\"|'[^']+'|[^\s;&|<>]+)")

SEGMENT_SPLIT = re.compile(r"&&|\|\||[;\n|]|\$\(|\)|`")


def repo_root() -> Path:
    """Repo root for THIS checkout.

    Derived from the script's own location (scripts/hooks/x.py -> root), which
    is correct inside a linked worktree as well. Falls back to git.
    """
    candidate = HERE.parent.parent
    if (candidate / ".git").exists():
        return candidate
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=5, cwd=str(candidate),
        )
        if out.returncode == 0 and out.stdout.strip():
            return Path(out.stdout.strip()).resolve()
    except (OSError, subprocess.SubprocessError):
        pass
    return candidate


def load_patterns() -> tuple[list[str], list[str]]:
    """Return (repo_relative_globs, absolute_globs)."""
    rel: list[str] = []
    absolute: list[str] = []
    if not PATTERN_FILE.exists():
        return rel, absolute
    for raw in PATTERN_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("~"):
            absolute.append(os.path.expanduser(line))
        elif line.startswith("/"):
            absolute.append(line)
        else:
            rel.append(line)
    return rel, absolute


def normalize(raw: str, cwd: Path) -> Path | None:
    raw = raw.strip().strip("\"'")
    if not raw or raw.startswith("-"):
        return None
    if raw in ("/dev/null", "/dev/stdout", "/dev/stderr"):
        return None
    expanded = os.path.expanduser(os.path.expandvars(raw))
    p = Path(expanded)
    if not p.is_absolute():
        p = cwd / p
    # Do NOT resolve() -- the file may not exist yet, and symlink resolution
    # would let a path escape the pattern it was written against.
    return Path(os.path.normpath(str(p)))


def matches(path: Path, root: Path, rel_globs: list[str], abs_globs: list[str]) -> str | None:
    s = str(path)
    for pattern in abs_globs:
        if fnmatch.fnmatch(s, pattern) or s == pattern:
            return pattern
    try:
        relative = path.relative_to(root)
    except ValueError:
        return None
    r = str(relative)
    for pattern in rel_globs:
        if fnmatch.fnmatch(r, pattern) or r == pattern:
            return pattern
        # Directory patterns: "scripts/hooks/**" should catch nested files even
        # though fnmatch treats ** as a plain wildcard across separators.
        if pattern.endswith("/**") and (r == pattern[:-3] or r.startswith(pattern[:-2])):
            return pattern
    return None


def candidate_paths_from_bash(command: str) -> list[str]:
    found: list[str] = []
    for match in REDIRECT.finditer(command):
        found.append(match.group(1))

    for segment in (s.strip() for s in SEGMENT_SPLIT.split(command)):
        if not segment:
            continue
        try:
            tokens = shlex.split(segment, posix=True)
        except ValueError:
            tokens = segment.split()
        if not tokens:
            continue
        idx = 0
        while idx < len(tokens) and ("=" in tokens[idx] and not tokens[idx].startswith("-")):
            idx += 1
        if idx >= len(tokens):
            continue
        if tokens[idx] in ("sudo", "command", "env", "nohup", "time", "xargs"):
            idx += 1
        if idx >= len(tokens):
            continue
        cmd = tokens[idx].rsplit("/", 1)[-1]
        args = tokens[idx + 1 :]
        if cmd in MUTATING_COMMANDS:
            found.extend(a for a in args if not a.startswith("-"))
        elif cmd in INPLACE_COMMANDS and any(INPLACE_FLAGS.match(a) for a in args):
            found.extend(a for a in args if not a.startswith("-"))
    return found


def candidate_paths_from_file_tool(tool_input: dict) -> list[str]:
    found: list[str] = []
    for key in ("file_path", "notebook_path", "path"):
        value = tool_input.get(key)
        if isinstance(value, str):
            found.append(value)
    for edit in tool_input.get("edits") or []:
        if isinstance(edit, dict) and isinstance(edit.get("file_path"), str):
            found.append(edit["file_path"])
    return found


DENY_TEMPLATE = """BLOCKED by scripts/hooks/guard-protected-paths.py (project PreToolUse hook).

  tool           : {tool}
  target path    : {path}
  matched rule   : {pattern}   (scripts/hooks/protected-paths.conf)

This path is protected configuration. An agent does not edit the files that
govern what agents may do -- that includes the hook registration, these hook
scripts, CI workflow definitions, .gitignore, and the founder's user-level
Claude/Codex settings (hardened 2026-07-27, already on the permissions deny
list).

If the change is genuinely needed:
  1. say what you want changed and why, and stop;
  2. the supervisor applies it, or removes the line from
     scripts/hooks/protected-paths.conf on a reviewed branch first.

Reads are not blocked -- inspect the file freely, just do not write it."""


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError) as exc:
        print(f"guard-protected-paths: unreadable hook payload: {exc}", file=sys.stderr)
        return 1

    tool = payload.get("tool_name") or ""
    tool_input = payload.get("tool_input") or {}
    cwd = Path(payload.get("cwd") or os.getcwd())

    if tool == "Bash":
        raw_paths = candidate_paths_from_bash(tool_input.get("command") or "")
    elif tool in ("Write", "Edit", "MultiEdit", "NotebookEdit", "Update"):
        raw_paths = candidate_paths_from_file_tool(tool_input)
    else:
        return 0

    if not raw_paths:
        return 0

    root = repo_root()
    rel_globs, abs_globs = load_patterns()
    if not rel_globs and not abs_globs:
        print(
            f"guard-protected-paths: pattern file missing or empty: {PATTERN_FILE}",
            file=sys.stderr,
        )
        return 1

    for raw in raw_paths:
        path = normalize(raw, cwd)
        if path is None:
            continue
        pattern = matches(path, root, rel_globs, abs_globs)
        if pattern:
            print(
                DENY_TEMPLATE.format(tool=tool, path=path, pattern=pattern),
                file=sys.stderr,
            )
            return 2

    return 0


if __name__ == "__main__":
    sys.exit(main())
