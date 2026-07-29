# Cross-repository stale bridge process sweep

## Problem

Long-lived Claude and Codex desktop sessions can retain `loop __bridge-mcp`
children that were spawned from old loop binaries for runs that have already
stopped or whose run directories no longer exist. Those binaries predate
bounded tmux control and can wedge the shared tmux server indefinitely. A new
loop binary cannot update an already-running child, and the existing startup
GC scans only the current repository's registered run processes.

An unsafe ad-hoc process regex already matched a live Codex app-server because
its `-c mcp_servers...` argument embedded the text `__bridge-mcp`. The sweep
therefore needs exact process identity and fail-closed run-state proof, not a
substring search.

## Requirements

1. Normal non-helper CLI startup must inspect bridge processes across every
   repository under the canonical loop runs root before starting a workspace.
2. Candidate discovery must first identify an executable whose basename is
   exactly `loop`, then accept only an exact four-token command shape:
   `<executable> __bridge-mcp <canonical-run-dir> <bridge-source>`.
3. The run directory must be the canonical two-level
   `<runs-root>/<repo-id>/<run-id>` location. Whitespace, traversal, extra
   arguments, relative paths, or an unknown source make identity ambiguous and
   must preserve the process.
4. A matching bridge may be signaled only when either:
   - its readable, identity-matching manifest is affirmatively terminal
     (`completed`, `failed`, or `stopped`); or
   - its exact canonical run directory is affirmatively absent.
5. A present but missing, malformed, unreadable, mismatched, active, or
   otherwise ambiguous manifest must preserve the process. `running` or
   `submitted` always wins over cleanup.
6. Immediately before `SIGTERM`, the sweep must read the PID's executable and
   command again and require the exact same validated identity. PID reuse or a
   changed command must preserve the process.
7. App-servers, Claude parent processes with embedded MCP JSON, the standing
   agent channel, run 100, non-loop processes, and all other ambiguous
   processes must never be signaled.
8. Enumeration and per-process failures must be contained. Startup continues,
   and `--help`, `--version`, and hidden helper subcommands continue to bypass
   maintenance.
9. The sweep must not delete run artifacts or registrations and must report a
   compact summary only when it signals or skips a candidate.

## Scope

- A conservative cross-repository stale bridge process sweep during startup.
- Exact process-command parsing and immediate pre-signal re-verification.
- Focused adversarial tests, including embedded bridge JSON in an app-server.
- No mutation of live run 100 and no manual live process sweep during
  implementation.
