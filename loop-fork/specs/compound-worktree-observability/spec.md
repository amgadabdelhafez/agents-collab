# Safe Compound Routing, Worktree Recognition, and Worker Detail

## Problem

Loop 54 is rejecting useful repository inspection commands for two independent
reasons:

1. The automatic router accepts a bounded `&&` read plan but rejects the common
   form where independently safe read stages are separated by `;`, often with
   literal `echo` labels between them.
2. Hook workspace recovery tokenizes the whole command before looking for a
   leading `cd <registered-worktree> &&`. An unsafe or unsupported remainder
   can therefore hide an otherwise valid registered-worktree hint and produce
   the misleading reason `workspace-unverified`.

The governess pane also has room to explain whether the worker is healthy and
useful, but currently shows only aggregate job and routing counts.

## Required behavior

### Compound read plans

- Accept two through six ordered top-level stages separated by `&&`, `;`, or a
  mixture of the two.
- Every executable stage must independently satisfy the existing broker-backed,
  read-only delegation grammar. The router must persist a structured plan; it
  must never pass an accepted shell compound to a general shell.
- Permit literal `echo` label stages only as presentation metadata. Labels may
  not contain expansion, substitution, redirection, flags, or executable shell
  syntax and must not become broker operations.
- Preserve existing per-stage bounds such as `head`, `tail`, and stderr
  suppression.
- Reject the entire candidate if any stage is empty, mutating, unbounded,
  unsupported, outside the verified workspace, or cannot be enforced by the
  broker.
- Continue rejecting raw newlines, heredocs, command or variable substitution,
  `||`, background execution, arbitrary redirection, arbitrary pipelines, and
  glob expansion.

### Registered-worktree recovery

- Recover a strict leading `cd <literal-path> &&` without tokenizing the command
  remainder.
- Treat the recovered path only as a workspace hint. The existing worktree
  verifier remains authoritative and must require a registered linked worktree
  sharing the expected common Git directory.
- Classify the remainder normally. Recognizing a worktree must not make an
  unsafe command delegable.
- An unsafe command beginning with a valid registered-worktree `cd` is rejected
  as `compound-or-unsafe-command`, not `workspace-unverified`.
- Missing, unrelated, substituted, or otherwise non-literal worktree targets
  remain unverified.

### Governess worker detail

- Add compact worker performance, load, context, and failure details using only
  persisted utility artifacts.
- Include success rate, average duration, average cost and tokens per finished
  job, tool calls per finished job, cache ratio, active/queued counts, routing
  share, context-capsule coverage, reference counts, and the most common tool
  failure code when available.
- Metrics must tolerate absent, partial, or malformed artifacts and avoid NaN,
  Infinity, crashes, or flickering back to blank values.
- Never display capsule contents, prompts, instruction text, secrets, or full
  hashes. Metadata-only display is permitted.
- Fit the existing governess pane through width-aware clipping and stable rows.

## Non-goals

- General shell execution by the worker.
- Python, Node, or Ruby script delegation.
- Mutation such as `git add`, `git commit`, file writes, copies, moves, removal,
  package installation, process control, or deployment.
- Multiple dependent Unix pipes, including `git show | grep | head`.
- Trusting an arbitrary directory merely because a command begins with `cd`.
- Restarting Claude or Codex panes in an active loop.

## Safety invariants

- Governess owns automatic delegation policy and the broker remains the only
  utility execution authority.
- One rejected stage rejects the whole compound.
- Workspace scope is derived from normalized broker operations, not from shell
  text alone.
- Existing claims, concurrency, timeout, output, and cost ceilings remain in
  force.

