#!/usr/bin/env python3
"""Audit and safely remove provably disposable Git worktrees.

Dry-run is the default. Apply mode never forces removal and revalidates every
candidate immediately before asking Git to remove it.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence


class ReaperError(RuntimeError):
    """A failed safety instrument or repository precondition."""


@dataclass(frozen=True)
class Worktree:
    path: Path
    head: str | None
    branch: str | None
    detached: bool
    locked: bool
    prunable: bool

    @property
    def label(self) -> str:
        if self.branch:
            return self.branch.removeprefix("refs/heads/")
        return "detached"


@dataclass(frozen=True)
class ProcessCwd:
    pid: int
    cwd: Path


@dataclass(frozen=True)
class Assessment:
    eligible: bool
    status: str
    detail: str


def run(
    argv: Sequence[str],
    *,
    cwd: Path,
    check: bool = False,
) -> subprocess.CompletedProcess[bytes]:
    try:
        result = subprocess.run(
            argv,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as exc:
        raise ReaperError(f"command could not start: {' '.join(argv)}: {exc}") from exc
    if check and result.returncode != 0:
        stderr = result.stderr.decode("utf-8", "replace").strip()
        raise ReaperError(f"command failed ({result.returncode}): {' '.join(argv)}: {stderr}")
    return result


def repository_root() -> Path:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as exc:
        raise ReaperError(f"Git repository discovery failed: {exc}") from exc
    if result.returncode != 0:
        raise ReaperError("not inside a non-bare Git worktree")
    return Path(os.fsdecode(result.stdout.rstrip(b"\n"))).resolve()


def parse_worktrees(raw: bytes) -> list[Worktree]:
    worktrees: list[Worktree] = []
    for record in raw.split(b"\0\0"):
        if not record:
            continue
        fields: dict[bytes, bytes] = {}
        flags: set[bytes] = set()
        for field in record.split(b"\0"):
            if not field:
                continue
            key, separator, value = field.partition(b" ")
            if separator:
                fields[key] = value
            else:
                flags.add(key)
        path_raw = fields.get(b"worktree")
        if path_raw is None:
            raise ReaperError("malformed git worktree porcelain: record has no path")
        worktrees.append(
            Worktree(
                path=Path(os.fsdecode(path_raw)),
                head=os.fsdecode(fields[b"HEAD"]) if b"HEAD" in fields else None,
                branch=os.fsdecode(fields[b"branch"]) if b"branch" in fields else None,
                detached=b"detached" in flags,
                locked=b"locked" in fields or b"locked" in flags,
                prunable=b"prunable" in fields or b"prunable" in flags,
            )
        )
    if not worktrees:
        raise ReaperError("git reported no worktrees")
    return worktrees


def list_worktrees(repo: Path) -> list[Worktree]:
    result = run(["git", "worktree", "list", "--porcelain", "-z"], cwd=repo, check=True)
    return parse_worktrees(result.stdout)


def resolve_base(repo: Path, base: str) -> str:
    result = run(
        ["git", "rev-parse", "--verify", "--quiet", f"{base}^{{commit}}"],
        cwd=repo,
    )
    if result.returncode != 0:
        raise ReaperError(f"base does not resolve to a commit: {base}")
    sha = result.stdout.decode("ascii", "strict").strip()
    if len(sha) != 40:
        raise ReaperError(f"base resolved to an invalid object id: {base}")
    return sha


def parse_lsof(raw: bytes) -> list[ProcessCwd]:
    processes: list[ProcessCwd] = []
    current_pid: int | None = None
    for token in raw.split(b"\0"):
        token = token.removeprefix(b"\n")
        if not token:
            continue
        kind, value = token[:1], token[1:]
        if kind == b"p":
            try:
                current_pid = int(value)
            except ValueError as exc:
                raise ReaperError("lsof emitted an invalid process id") from exc
        elif kind == b"n" and current_pid is not None:
            processes.append(ProcessCwd(pid=current_pid, cwd=Path(os.fsdecode(value))))
    return processes


def inventory_process_cwds() -> list[ProcessCwd]:
    configured = os.environ.get("WORKTREE_REAPER_LSOF")
    executable = configured or shutil.which("lsof")
    if not executable:
        raise ReaperError("lsof is required for the process cwd safety check")
    try:
        result = subprocess.run(
            [executable, "-n", "-d", "cwd", "-F0pn"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as exc:
        raise ReaperError(f"lsof process cwd inventory failed: {exc}") from exc
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", "replace").strip()
        raise ReaperError(f"lsof process cwd inventory failed ({result.returncode}): {stderr}")
    return parse_lsof(result.stdout)


def path_is_at_or_below(candidate: Path, root: Path) -> bool:
    candidate_resolved = candidate.resolve(strict=False)
    root_resolved = root.resolve(strict=False)
    return candidate_resolved == root_resolved or root_resolved in candidate_resolved.parents


def processes_inside(worktree: Path, processes: Iterable[ProcessCwd]) -> list[int]:
    return sorted(
        {process.pid for process in processes if path_is_at_or_below(process.cwd, worktree)}
    )


def assess(repo: Path, worktree: Worktree, base_sha: str, processes: list[ProcessCwd]) -> Assessment:
    if worktree.locked:
        return Assessment(False, "KEEP_LOCKED", "worktree registration is locked")
    if worktree.head is None:
        return Assessment(False, "KEEP_UNKNOWN_HEAD", "registration has no exact HEAD")

    ancestry = run(
        ["git", "merge-base", "--is-ancestor", worktree.head, base_sha],
        cwd=repo,
    )
    if ancestry.returncode == 1:
        ahead = run(
            ["git", "rev-list", "--count", f"{base_sha}..{worktree.head}"],
            cwd=repo,
        )
        detail = "HEAD is not merged into base"
        if ahead.returncode == 0:
            detail += f"; {ahead.stdout.decode('ascii', 'replace').strip()} commit(s) ahead"
        return Assessment(False, "KEEP_UNMERGED", detail)
    if ancestry.returncode != 0:
        return Assessment(False, "KEEP_ANCESTRY_ERROR", "Git could not prove HEAD ancestry")

    status = run(
        ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        cwd=worktree.path,
    )
    if status.returncode != 0:
        return Assessment(False, "KEEP_STATUS_ERROR", "Git status failed")
    if status.stdout:
        return Assessment(False, "KEEP_DIRTY", "tracked or untracked changes are present")

    pids = processes_inside(worktree.path, processes)
    if pids:
        return Assessment(False, "KEEP_IN_USE", "process cwd at or below worktree; pid(s)=" + ",".join(map(str, pids)))

    return Assessment(True, "REAPABLE", "merged, clean, and not in use")


def quote(value: object) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def report(status: str, worktree: Worktree, detail: str) -> None:
    print(
        f"{status} path={quote(str(worktree.path))} label={quote(worktree.label)} "
        f"head={quote(worktree.head)} detail={quote(detail)}"
    )


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Audit registered Git worktrees and safely remove only proven disposable ones."
    )
    parser.add_argument("--apply", action="store_true", help="remove eligible worktrees; default is dry-run")
    parser.add_argument(
        "--base",
        default="origin/main",
        help="integration ref used for merged-HEAD proof (default: origin/main)",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    try:
        repo = repository_root()
        worktrees = list_worktrees(repo)
        primary = worktrees[0].path.resolve(strict=False)
        base_sha = resolve_base(repo, args.base)
        processes = inventory_process_cwds()
    except ReaperError as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return 2

    print(f"BASE ref={quote(args.base)} commit={quote(base_sha)} mode={quote('apply' if args.apply else 'dry-run')}")
    candidates = sorted(worktrees[1:], key=lambda item: os.fsencode(item.path))
    counts = {"scanned": len(candidates), "reapable": 0, "reaped": 0, "kept": 0, "stale": 0, "failed": 0}

    for worktree in candidates:
        if worktree.path.resolve(strict=False) == primary:
            report("KEEP_PRIMARY", worktree, "primary worktree is never removable")
            counts["kept"] += 1
            continue
        if not worktree.path.exists() or worktree.prunable:
            report("STALE_REGISTRATION", worktree, "path is absent or Git marked it prunable")
            counts["stale"] += 1
            continue

        try:
            assessment = assess(repo, worktree, base_sha, processes)
        except ReaperError as exc:
            report("FAILED_CHECK", worktree, str(exc))
            counts["failed"] += 1
            continue
        if not assessment.eligible:
            report(assessment.status, worktree, assessment.detail)
            counts["kept"] += 1
            continue

        counts["reapable"] += 1
        if not args.apply:
            report("WOULD_REAP", worktree, assessment.detail)
            continue

        try:
            fresh_processes = inventory_process_cwds()
            refreshed = next(
                (
                    item
                    for item in list_worktrees(repo)
                    if item.path.resolve(strict=False) == worktree.path.resolve(strict=False)
                ),
                None,
            )
            if refreshed is None:
                raise ReaperError("registration disappeared before removal")
            reassessment = assess(repo, refreshed, base_sha, fresh_processes)
        except ReaperError as exc:
            report("FAILED_REVALIDATION", worktree, str(exc))
            counts["failed"] += 1
            continue
        if not reassessment.eligible:
            report("KEEP_CHANGED", refreshed, reassessment.status + ": " + reassessment.detail)
            counts["kept"] += 1
            continue

        removal = run(["git", "worktree", "remove", "--", str(refreshed.path)], cwd=repo)
        if removal.returncode != 0:
            detail = removal.stderr.decode("utf-8", "replace").strip() or "git worktree remove failed"
            report("FAILED_REMOVE", refreshed, detail)
            counts["failed"] += 1
            continue
        report("REAPED", refreshed, reassessment.detail)
        counts["reaped"] += 1

    if args.apply and counts["stale"]:
        prune = run(["git", "worktree", "prune"], cwd=repo)
        if prune.returncode != 0:
            counts["failed"] += 1
            print("FAILED_PRUNE detail=" + quote(prune.stderr.decode("utf-8", "replace").strip()))

    print(
        "SUMMARY "
        + " ".join(f"{key}={value}" for key, value in counts.items())
        + f" primary={quote(str(primary))}"
    )
    return 1 if counts["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
