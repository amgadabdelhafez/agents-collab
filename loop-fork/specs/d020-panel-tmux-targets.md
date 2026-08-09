# D-020 panel tmux target binding

## Problem

The dashboard enumerates the ambient tmux server and prints an unqualified
attach command. It can hide recorded runs, merge identical session names from
different servers, or direct a supervisor to the wrong server.

## Required behavior

- Derive panel rows from run manifests, never ambient tmux discovery.
- Query only the deduplicated set of valid recorded sockets.
- Keep `(socket, session)` identities distinct across servers.
- Render valid-and-present targets live with a shell-safe qualified attach hint.
- Retain valid-and-absent targets as dead.
- Retain missing, invalid, conflicting, and failed-query targets as unknown and
  non-attachable.
- A failed query affects only rows on that socket.

## Acceptance

- Tests prove the three row states, two-server identity, partial query failure,
  no ambient fallback, and shell-safe attach formatting.
- Focused suite, scoped static, build, diff check, and independent zero-write
  review pass.
