# Web UI T-00: durable adapter identity and resolved configuration

## Outcome

New run manifests persist enough immutable, redacted evidence for future Web
readers to identify the exact tmux server instance and effective safe
configuration without guessing or acquiring runtime authority.

This slice implements only T-00 from `specs/webui-control-plane/tasks.md`.

## Requirements

- Persist a versioned structured tmux identity containing the canonical socket
  path, server PID, and positive OS process-birth identity.
- Capture cold identity only after the launched server is live; persist known
  identity for both existing-server and cold-launch paths.
- Obtain socket provenance from the launched tmux server's `#{socket_path}`;
  canonicalize the parent directory plus socket basename without resolving a
  live socket inode.
- Persist a frozen, versioned resolved-config snapshot after paired options are
  applied. Coerce optional booleans explicitly and map absence to false.
- Strictly allowlist review/reviewPlan, proofConfigured, and safe runtime
  toggles. Exclude prompts, proof values, URLs, paths, sessions, workspaces,
  credentials, providers, MCP payloads, and hidden environment.
- Define `manifestRevision` as SHA-256 of the exact validated persisted bytes.
- Preserve atomic temp-file-plus-rename writes and fail closed on invalid UTF-8,
  JSON, schema, or identity.
- Legacy manifests remain readable with unknown adapter identity and no
  invented configuration.
- Add an explicit socket/server-instance-bound diagnostic context that always
  invokes tmux with exact `-S`; no default-server fallback.
- Do not change launch/resume/control admission or add Web mutation authority.

## Allowed implementation paths

- `loop-fork/src/loop/run-state.ts`
- `loop-fork/src/loop/paired-options.ts`
- `loop-fork/src/loop/tmux-control.ts`
- `loop-fork/src/loop/tmux.ts`
- The four corresponding `loop-fork/tests/loop/*.test.ts` files
- Task-owned Harness evidence and this spec bundle

Any additional product path requires an explicit scope update before editing.

## Non-goals

- T-01 projections or T-02 server/SSE work.
- Changes to launch authorization, lifecycle controls, provider selection, or
  live runtime defaults.
- Reuse of unverified patches from abandoned T-00 recovery worktrees.
