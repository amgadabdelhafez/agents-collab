# D-014: Paired launch cleanup ordering

## Problem

A failed paired startup requests proxy shutdown while its own manifest still
declares an active tmux session. The proxy correctly rejects that request with
HTTP 409, so cleanup obscures the original startup failure and leaves automatic
GC to recover later.

## Required behavior

- Cleanup of an owned failed launch targets only its recorded tmux socket and
  session.
- The owned session is removed and the manifest is durably terminal before the
  exact proxy/app-server teardown request.
- Proxy or app-server cleanup failures are logged separately and never replace
  the original startup error.
- Unknown or missing socket identity never authorizes an ambient tmux kill.
- A duplicate-start loser never kills the live winner.

## Acceptance

1. A producer-shaped startup failure with a live owned session and proxy sees
   the exact socket session dead and the manifest failed when proxy shutdown is
   requested.
2. The primary synthetic startup error remains the rejected error.
3. The exact kill command contains the recorded `tmux -S` socket and session.
4. Missing socket identity cannot produce a kill command.
5. Existing active-proxy rejection and terminal-proxy acceptance tests pass.
6. Focused tests, static checks, build, and `git diff --check` pass.

## Non-goals

- Broad remaining tmux consumer migration.
- Product-lane changes, merge, push, or installed-binary deployment.

## Completion

Completed 2026-08-09 after focused tests and independent zero-write review.
