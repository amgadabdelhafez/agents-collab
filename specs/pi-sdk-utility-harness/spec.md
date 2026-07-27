# Shared Pi governance and utility harness

## Problem

The loop currently has two unrelated LLM clients: governess calls the local
MLX model through one-off HTTP requests, while utility jobs run GLM through a
custom OpenAI-compatible agent loop. Exact broker operations also pay for an
LLM even when the request already contains every argument. That duplicates
harness behavior, wastes local capacity, and lets provider-specific lifecycle
details leak into routing.

## Goal

Use the official Pi SDK as the common model runtime for both the local
governess model and bounded utility agents. Keep governess as the deterministic
policy owner and the existing broker as the only tool/permission boundary.

Route each accepted job to exactly one execution tier:

1. `utility-direct`: exact structured broker calls with no model.
2. `utility-nanny`: small, read-only bounded reasoning on local Qwen through Pi.
3. `utility-au-pair`: larger bounded reasoning and patch proposals on GLM through Pi.
4. Claude/Codex: authority, design, review, risky, unbounded, or unsupported work.

No request is submitted to two models. A local failure or full local slot does
not automatically retry on GLM; escalation is an explicit durable route change.

## Requirements

1. Pin matching `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`
   versions in the repository lockfile and record the version in diagnostics.
2. Provide one shared Pi runtime abstraction for local MLX and OpenRouter GLM.
   Credentials remain in memory, are never written to Pi state, and traces are
   redacted. No LiteLLM or additional proxy is introduced in this slice.
3. Governess liveness and safety decisions remain deterministic. Its local LLM
   calls are advisory classifications/summaries only and use ephemeral,
   no-tools Pi sessions. Existing injected-fetch test seams remain available.
4. Each model-backed utility job gets one ephemeral Pi session with no prior
   chat, global session discovery, persistent credentials, third-party
   extensions, skills, prompts, or agent files.
5. Disable every Pi built-in tool. Register only adapters for broker-approved
   definitions. Broker scope, protected paths, validation, output limits,
   command policy, and guarded patch application remain authoritative.
6. Execute exact `file-read` and `focused-check` profiles directly through the
   broker. Execute a structured read plan directly only when every step has
   complete structured arguments; otherwise assign exactly one model tier.
7. Local-model utility eligibility is conservative: low-risk, read-only,
   bounded inspect/command work with a small declared plan and no patch/edit
   capability. Edits and broader bounded investigations route to GLM.
8. Local utility concurrency defaults to one so watchdog judgments are not
   starved. GLM concurrency remains independently configurable (default four).
   Direct jobs consume neither model slot.
9. Persist the chosen tier on the route decision before claim. Workers use only
   that tier's provider/model. Capacity checks are per tier; a full tier leaves
   its job pending instead of transferring ownership.
10. Translate Pi events into existing progress, tool-event, trace, artifact,
    check, result, and usage records. Include harness, tier, provider, model,
    and Pi version in usage evidence.
11. Preserve runaway fuses and add total and sibling-batch tool-call ceilings.
    Stop on repeated broker rejection/calls, model-call ceiling, runtime,
    cancellation, or externally reaped claim. Never auto-fallback to legacy or
    another model after work begins.
12. Preserve completion evidence and `CONTEXT_INSUFFICIENT` semantics. A model
    cannot claim success without the broker evidence required by the request.
13. `LOOP_UTILITY_HARNESS=pi-sdk|legacy` defaults to `pi-sdk`. Legacy is an
    explicit rollback/testing backend, not an automatic fallback. Direct jobs
    remain direct under either setting.
14. A safe Pi CLI/operator surface may be added only if it installs the same
    broker-backed tools with all built-ins disabled. Otherwise record it as a
    follow-up; do not widen permissions for convenience.
15. Source Bun and the compiled binary must both work. Update architecture and
    dependency documentation. Do not change paired-agent topology, restart
    Loop 55, push remotely, or automatically apply proposed patches.
16. Use distinct operator-facing role names consistently: Governess is the
    deterministic supervisor, Nanny is local Qwen, and Au Pair is GLM. New
    loops have separate filtered Nanny and Au Pair panes. Stable legacy
    `utility` fields/subcommands may remain as compatibility aliases, but pane
    titles, messages, help, traces, and new tier IDs use the role names.

## Acceptance

- Pure routing tests prove exact/direct, small/Nanny, larger/Au Pair, and main-agent
  decisions, including one-owner behavior and no automatic cross-tier fallback.
- Direct-path tests prove exact reads and focused checks make zero model calls
  and still emit broker evidence, artifacts/checks, and compact results.
- Pi fake-provider tests prove both local and GLM configurations, multi-turn
  tool use, dynamic read-plan tools, lifecycle evidence, and usage translation.
- Security tests prove Pi exposes no built-ins, secrets do not enter traces,
  and broker path/command/write controls remain unchanged.
- Lifecycle tests cover completion, insufficient context, provider failure,
  malformed arguments, rejection/repetition ceilings, sibling batch ceiling,
  timeout, cancellation, and externally reaped work.
- A live local MLX no-tools completion and harmless brokered tool canary pass.
  A live GLM canary is optional and must remain budget-bounded.
- Focused tests, full `bun test`, compiled `bun run build`, compiled canary,
  `git diff --check`, and `scripts/verify.sh` pass.
- Loop 55 pane IDs and PIDs remain unchanged.
- New-loop layout exposes distinct `nanny.<session>` and `au-pair.<session>`
  panes, each filtered to its tier, without hiding Governess statistics.
- `runs/pi-sdk-utility-harness/eval.json` records PASS from an evaluator
  distinct from the implementation agent before release or installation.

## Non-goals

- Replacing governess, routing policy, durable jobs, context capsules, bridge,
  or the tool broker with Pi components.
- Making the local model a peer agent, user chat surface, or policy authority.
- Adding a general model gateway, multi-tenant key service, load balancer, or
  LiteLLM deployment.
- Enabling Pi built-in bash/read/write/edit tools, persistent chat, autonomous
  worktrees, commits, merges, deployments, browser tools, or credential access.
- Migrating Claude or Codex panes to Pi.
