#!/usr/bin/env python3
"""PreToolUse hook: refuse bulk git staging.

WHY THIS EXISTS
---------------
Written lessons about staging discipline demonstrably do not hold. The
retrospective for the Feb-Jul 2026 window recorded a bookmark-sweep incident
that recurred ONE COMMIT after the founder wrote a note telling agents not to
do it. Prose is advisory; a PreToolUse hook is not. This file is that lesson
re-expressed as enforcement.

WHAT IT BLOCKS
--------------
Any Bash command that stages the whole working tree instead of named paths:

    git add -A                git add --all           git add -Av
    git add .                 git add ./              git add :/
    git add '*'               git stage -A            git stage .
    git commit -a             git commit -am "msg"    git commit --all

`git commit -a` is included deliberately: it is the same sweep with a
different spelling, and it is the first thing an agent reaches for once
`git add -A` stops working. A guard with a one-character bypass is theatre.

WHAT IT DOES NOT BLOCK
----------------------
  * `git add <path> [<path>...]`          - explicit paths, the intended form
  * `git add -p` / `--patch`, `-u`, `-N`  - not whole-tree sweeps
  * anything that is not a `git add` / `git stage` / `git commit` invocation

`git add -u` is deliberately NOT blocked: it stages modifications to already
tracked files only, so it cannot sweep an unrelated new file into a commit.
It is still worth avoiding; that part stays prose.

CONTRACT
--------
stdin  : PreToolUse hook JSON (tool_name, tool_input, cwd, ...)
exit 0 : allow
exit 2 : deny; stderr is fed back to the agent as the reason
other  : non-blocking error (Claude Code surfaces stderr, tool proceeds)

Self-test: scripts/hooks/test-hooks.sh
"""

from __future__ import annotations

import json
import re
import shlex
import sys

# Bulk pathspecs: "stage everything reachable from here".
BULK_PATHSPECS = {".", "./", ".\\", ":/", ":/.", "*", "'*'", '"*"'}

# git-level options that take a separate value argument and must be skipped
# before we can identify the subcommand.
GIT_OPTS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"}

SEGMENT_SPLIT = re.compile(r"&&|\|\||[;\n|]|\$\(|\)|`")


def segments(command: str) -> list[str]:
    """Split a compound shell command into candidate simple commands.

    Deliberately crude. The goal is not a shell parser, it is to make sure
    `cd foo && git add -A` and `git add -A; git commit` are both seen.
    """
    return [s.strip() for s in SEGMENT_SPLIT.split(command) if s and s.strip()]


def tokenize(segment: str) -> list[str]:
    try:
        return shlex.split(segment, posix=True)
    except ValueError:
        # Unbalanced quotes: fall back to whitespace splitting rather than
        # silently allowing the command through unexamined.
        return segment.split()


def find_git_subcommand(tokens: list[str]) -> tuple[str | None, list[str]]:
    """Return (subcommand, remaining_args) for a git invocation, else (None, [])."""
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        base = tok.rsplit("/", 1)[-1]
        if base == "git":
            break
        # Allow env prefixes such as `GIT_AUTHOR_NAME=x git add -A`.
        if "=" in tok and not tok.startswith("-"):
            i += 1
            continue
        if base in ("env", "sudo", "command", "nohup", "time"):
            i += 1
            continue
        return None, []
    else:
        return None, []

    i += 1
    while i < len(tokens):
        tok = tokens[i]
        if not tok.startswith("-"):
            return tok, tokens[i + 1 :]
        if tok in GIT_OPTS_WITH_VALUE:
            i += 2
            continue
        i += 1
    return None, []


def short_cluster_has(tok: str, letter: str) -> bool:
    """True for `-A`, `-Av`, `-am` style clusters containing `letter`."""
    return tok.startswith("-") and not tok.startswith("--") and letter in tok[1:]


def offending_add(args: list[str]) -> str | None:
    saw_double_dash = False
    for tok in args:
        if tok == "--":
            saw_double_dash = True
            continue
        if not saw_double_dash and tok.startswith("-"):
            if tok in ("--all", "--no-ignore-removal"):
                return tok
            if short_cluster_has(tok, "A"):
                return tok
            continue
        if tok in BULK_PATHSPECS:
            return tok
    return None


def offending_commit(args: list[str]) -> str | None:
    for tok in args:
        if tok == "--":
            break
        if tok == "--all":
            return tok
        if tok.startswith("--"):
            continue
        if short_cluster_has(tok, "a"):
            return tok
    return None


DENY_TEMPLATE = """BLOCKED by scripts/hooks/block-bulk-git-add.py (project PreToolUse hook).

  offending command : {segment}
  offending token   : {token}

Bulk staging is not allowed in this repository or any of its worktrees.
Stage the exact paths you changed instead:

  git status --short          # see what is actually dirty
  git add path/one path/two   # name every path
  git commit -m "..."         # no -a

Why: a whole-tree stage sweeps unrelated local files -- editor state, other
agents' in-flight edits, gitignore-adjacent artifacts -- into a commit that
claims to be about something else. This exact failure recurred one commit
after it was written down as a lesson, which is why it is now a hook and not
a paragraph. There is no environment-variable bypass; if bulk staging is
genuinely required, the supervisor runs it in their own shell."""


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError) as exc:
        print(f"block-bulk-git-add: unreadable hook payload: {exc}", file=sys.stderr)
        return 1

    if payload.get("tool_name") != "Bash":
        return 0

    command = (payload.get("tool_input") or {}).get("command") or ""
    if not command:
        return 0

    for segment in segments(command):
        tokens = tokenize(segment)
        if not tokens:
            continue
        sub, args = find_git_subcommand(tokens)
        if sub in ("add", "stage"):
            token = offending_add(args)
        elif sub == "commit":
            token = offending_commit(args)
        else:
            continue
        if token:
            print(DENY_TEMPLATE.format(segment=segment, token=token), file=sys.stderr)
            return 2

    return 0


if __name__ == "__main__":
    sys.exit(main())
