# Spec: Utility-first native fallback

## Problem

The paired-loop prompts tell Claude and Codex to use Direct, Nanny, and Au
Pair, but their provider-native delegation tools remain available. Max/Ultra
models can therefore create an independent subagent fleet that bypasses
Governess routing, utility accounting, and the one-owner job journal. Prompt
language alone neither caps that fleet nor makes a spawned child read-only.

## Goal

Make the paired-loop delegation order enforceable:

1. direct deterministic execution;
2. Nanny for bounded local inspection and summarization;
3. Au Pair for bounded reasoning, small patch proposals, and focused proof;
4. at most one short-lived, read-only provider-native fallback after a
   Governess lease;
5. Claude and Codex retain architecture, ambiguity, authority, integration,
   patch application, and final review.

The default is `utility-first`. A `strict` mode removes provider-native
subagents entirely. An explicit `off` compatibility mode leaves native
subagents outside this policy.

## Required behavior

1. `LOOP_NATIVE_SUBAGENT_MODE` accepts `utility-first`, `strict`, or `off` and
   defaults to `utility-first`. Unknown values fail closed to `strict`.
2. In `utility-first`, Codex is configured for one concurrent spawned thread.
   Claude receives one session-local custom fallback profile. Both provider
   hooks observe per-tool and subagent lifecycle events.
3. A main agent requests a native fallback through the loop bridge. The packet
   names one objective, `explore` or `review`, one through eight repo-relative
   non-protected read scopes, acceptance criteria, a reason, and one through
   three terminal utility task IDs owned by that requester.
4. Only the supervisor may omit utility task evidence for an explicitly
   human-authorized fallback. Main agents cannot self-assert that exception or
   override the requester identity.
5. The bridge durably records a pending request. The current Governess epoch
   deterministically grants or denies it on a later tick. It grants only when
   the evidence still exists, the request remains safe, and no granted,
   consumed, or running fallback occupies the single run-wide slot.
6. A grant expires after 120 seconds if unused. The next matching provider
   native spawn by the requester atomically consumes it. A missing, stale,
   wrong-requester, wrong-profile, duplicate, or descendant spawn is denied by
   `PreToolUse` and journaled.
7. Claude may spawn only the session-local `loop-readonly-fallback` profile.
   That profile exposes `Read`, `Grep`, and `Glob` only, runs in the foreground,
   has a bounded turn count, and cannot invoke MCP tools or descendants.
8. Codex may spawn only the loop-scoped `loop_readonly_fallback` profile. Its
   configuration is read-only and disables descendant agents. Provider hooks
   additionally deny mutation, shell, MCP, web, user-input, and nested-agent
   tools whenever a tool event is identified as coming from a native child.
9. `SubagentStart` binds the consumed lease to the provider child and injects
   the exact read scopes and acceptance contract. `SubagentStop` closes the
   lease. Orphaned consumed/running leases time out fail closed.
10. `strict` writes `agents.enabled = false` for Codex and starts Claude with
    native agent tools disallowed. Hooks retain a deny path for defense in
    depth and telemetry when a provider still surfaces a call.
11. Governess shows the effective native mode, slot state, requests, grants,
    active/finished counts, blocked attempts, and the latest fallback/denial
    reason without displacing the four agent/helper identity rows in a small
    viewport.
12. Shared main-agent guidance uses the same ordering and says that native
    fallback is never a substitute for a safe Direct, Nanny, or Au Pair packet.

## Safety boundary

- A native child is inspection-only. It cannot edit, write, run a shell,
  access bridge or other MCP tools, browse the network, ask the human, apply a
  utility patch, commit, push, merge, deploy, or create descendants.
- Governess is the only grant authority. Bridge submission, hook consumption,
  provider lifecycle observation, and pane rendering are adapters around its
  durable lease state.
- One slot is run-wide across Claude and Codex, not one per provider.
- Leases are requester-, epoch-, profile-, scope-, and time-bound and are
  consumed at most once under a file lock.
- Missing manifests, malformed journals, stale epochs, unknown modes,
  protected scopes, missing utility evidence, or hook errors deny a native
  spawn. Ordinary non-native hook telemetry remains best-effort.
- This slice does not restart or hot-swap any live Claude or Codex pane.

## Non-goals

- Replacing Direct, Nanny, Au Pair, Pi, or the deterministic task router.
- Allowing native children to author or apply patches.
- Turning native fallback into a second worker pool.
- Automatically choosing architecture, product, release, credential, remote,
  destructive, migration, or human-authority work for a child.
- Reconfiguring user-global Claude or Codex settings.
