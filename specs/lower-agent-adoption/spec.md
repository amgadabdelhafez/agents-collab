# Spec: Lower-Agent Delegation Adoption

## Problem

The governed GLM utility tier is available, bounded, observable, and safe, but
loop 45 completed with no utility jobs. Both main agents were told to use
`route_task`; Claude explicitly loaded the tool and still performed mechanical
repository inspection and focused commands directly. Governess currently only
processes requests that an agent has already submitted, so prompt-only guidance
does not reliably move token load away from the frontier pair.

## Goal

Make lower-agent adoption measurable and make delegation mandatory for a small,
deterministic class of clearly mechanical operations in new paired loops. Keep
judgment, architecture, review, product decisions, ambiguous work, and protected
content with the main agents. Preserve the existing fail-closed router as the
only authority that decides whether a submitted job may execute on the utility
tier.

## Requirements

1. Add a pure delegation classifier for main-agent tool intents. It may classify
   only bounded repository reads/searches, repository status/diff inspection,
   literal focused verification commands, and similarly narrow mechanical
   operations. Unknown or ambiguous inputs are not enforceable.
2. Claude's existing `PreToolUse` hook automatically appends a structured route
   request and denies the original native tool call only when the classifier is
   certain, utility runtime configuration is available, and the request remains
   inside declared safe scope. The denial names the utility task and tells
   Claude to use `task_status`/`get_task_result` rather than retrying directly.
3. The hook must not route protected, secret-like, governing-instruction,
   architectural, destructive, remote, compound-shell, or dependency-changing
   operations. Hook/classifier failures fail open so main-agent progress is not
   stranded.
4. Codex currently exposes only coarse lifecycle hooks. Its app-server proxy
   records deterministic utility-like command/file events as missed delegation
   telemetry, while its loop prompt makes route-first behavior mandatory. This
   slice must not pretend Codex has a pre-execution enforcement surface that the
   installed client does not provide.
5. Explicit `route_task` calls and automatic hook routes share the existing
   durable utility job protocol and router. Automatic classification cannot
   bypass risk, authority, scope, health, conflict, epoch, or budget gates.
6. Persist compact, secret-safe delegation telemetry under the run's `utility/`
   directory: agent, disposition, operation class, reason, fingerprint, task id
   when present, and timestamp. Do not persist raw file contents, command output,
   credentials, or unbounded prompt text.
7. The lower-agent pane reports automatic/explicit routes, observed candidates,
   missed Codex candidates, and the latest delegation reason alongside existing
   worker status.
8. Add the route-first rule to Claude MCP channel instructions as well as paired
   startup prompts so later dynamic MCP instruction updates do not dilute the
   policy.
9. Default new paired loops to enforcement. Support
   `LOOP_UTILITY_DELEGATION_MODE=observe` for measurement-only rollout and
   `off` for diagnosis. Invalid values fail closed to `observe`, not broad
   enforcement.
10. Do not modify, restart, re-pane, signal, or message loop 45. Release applies
    only to subsequently started loops through the canonical local entrypoint.
11. Do not push remotely.

## Initial enforceable classes

- Bounded Claude `Grep`/`Glob` requests with an explicit safe repository scope.
- Large Claude `Read` requests for a single safe non-governing file.
- Single, shell-free source-slice/search commands that map to the utility
  inspection tools.
- Repository `git status` and path-scoped `git diff` inspection.
- Literal, path-scoped `bun test ...` and `npx vitest run ...` focused checks.

Direct use remains allowed for small contextual reads, governing specs and
instructions, multi-file/cross-cutting investigation, algebra and design work,
review, edits already authored by the main agent, commands with unclear effects,
and any operation outside the classifier's exact grammar.

## Acceptance criteria

- [x] Pure table tests prove eligible and exempt tool intents, path containment,
      governing/protected exclusions, secret-like exclusions, and shell-free
      parsing.
- [x] Claude hook tests prove enforce mode queues one idempotent job and returns
      a valid `PreToolUse` denial; observe/off/unavailable/error modes do not
      block the original tool.
- [x] Automatic requests still receive ordinary governess route decisions and
      cannot bypass utility safety gates.
- [x] Codex proxy tests prove command candidates are recorded without blocking
      or altering app-server traffic.
- [x] Bridge tests prove explicit routes write delegation telemetry.
- [x] Pane tests show route/missed counts and the latest compact reason without
      exposing command text or credentials.
- [x] Prompt/settings tests contain mandatory route-first guidance and the
      configured delegation mode.
- [x] Focused tests, full `bun test`, `bun run build`, `git diff --check`, and
      `scripts/verify.sh` complete with unrelated baseline failures isolated.
- [x] A different evaluator records `runs/lower-agent-adoption/eval.json` before
      integration.
- [ ] The global loop entrypoint is updated atomically for future loops, while
      loop-45 pane IDs/PIDs remain unchanged.

## Non-goals

- Routing the original human task or replacing either main agent.
- Asking GLM to make architecture, review, product, release, or authority calls.
- Auto-routing arbitrary Bash, arbitrary edits, or shell pipelines.
- Claiming hard pre-execution enforcement for Codex without a supported hook or
  approval boundary.
- Retrofitting or testing the feature inside loop 45.
