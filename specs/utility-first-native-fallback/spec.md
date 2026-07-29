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
4. at most one **concurrent** short-lived, provider-enforced read-only native
   fallback after a Governess lease;
5. Claude and Codex retain architecture, ambiguity, authority, integration,
   patch application, and final review.

The governed tmux topology defaults to `utility-first`. A `strict` mode removes
provider-native subagents entirely. An explicit `off` compatibility mode leaves
native subagents outside this policy; legacy non-tmux pairing resolves to this
mode because it has no Governess process or provider-hook lifecycle.

## Required behavior

1. `LOOP_NATIVE_SUBAGENT_MODE` accepts `utility-first`, `strict`, or `off` and
   defaults governed tmux runs to `utility-first`. Unknown values fail closed
   to `strict`; non-tmux paired compatibility runs resolve to `off` rather than
   claiming enforcement without a Governess.
2. In `utility-first`, Codex native agents are disabled because Codex 0.145
   reapplies the full-access parent sandbox after loading a custom role, so its
   role-local `read-only` setting is not an effective boundary. Claude receives
   one session-local custom fallback profile. Both provider hooks observe
   per-tool and subagent lifecycle events; Codex spawn attempts are denied and
   journaled.
3. Claude requests a native fallback through the loop bridge. Codex is told to
   keep using Direct, Nanny, Au Pair, or a targeted Claude peer review. The packet
   names one objective, `explore` or `review`, one through eight non-root
   repo-relative non-protected read scopes, acceptance criteria, a reason, and
   one through three settled utility task IDs owned by that requester. A
   settled task has either a terminal result or a deterministic non-utility
   route decision.
4. Only the supervisor may omit utility task evidence for an explicitly
   human-authorized fallback. Main agents cannot self-assert that exception or
   override the requester identity.
5. The bridge durably records a pending request. The current Governess epoch
   deterministically grants or denies it on a later tick. It grants only when
   the settled evidence still exists, the request remains safe, and no granted,
   consumed, or running fallback occupies the single run-wide **concurrency**
   slot. The slot bounds how many fallbacks may exist AT ONCE, not how many a
   run may have in total: a `completed`, `expired`, or `denied` fallback frees
   it, and a later well-evidenced request is then grantable. Denial names the
   occupant (`native-slot-busy:<request-id>`). Requirement 6's 120-second
   expiry exists precisely to free this slot, so a permanent one-per-run
   reading would make that expiry meaningless.
6. A grant expires after 120 seconds if unused. The next matching provider
   native spawn by the requester atomically consumes it. A missing, stale,
   wrong-requester, wrong-profile, duplicate, or descendant spawn is denied by
   `PreToolUse` and journaled.
7. Claude may spawn only the session-local `loop-readonly-fallback` profile.
   That profile exposes `Read` and `Grep` only, runs in the foreground, has a
   bounded turn count, and cannot invoke MCP tools or descendants. Hook policy
   permits only explicit existing regular-file operands, not recursive
   directory reads.
8. Codex has `agents.enabled = false` in both `utility-first` and `strict`.
   Governess never grants a Codex native lease, the bridge rejects Codex native
   requests with the provider-sandbox reason, and the root hook retains a
   fail-closed deny path plus telemetry if a spawn tool is nevertheless
   surfaced. Loop setup removes any stale `loop_readonly_fallback` profile from
   earlier builds while preserving the root hook across live tmux reattachment.
9. `SubagentStart` binds the consumed lease to the provider child and injects
   the exact read scopes and acceptance contract. `SubagentStop` closes the
   lease. Orphaned consumed/running leases time out fail closed.
10. `strict` additionally starts Claude with native agent tools disallowed.
    Hooks retain a deny path for defense in depth and telemetry when a provider
    still surfaces a call.
11. Governess shows the effective native mode, slot state, requests, grants,
    active/finished counts, blocked attempts, and the latest fallback/denial
    reason without displacing the four agent/helper identity rows in a small
    viewport.
12. Shared main-agent guidance uses the same ordering and says that native
    fallback is never a substitute for a safe Direct, Nanny, or Au Pair packet.

## Safety boundary

- A native child is inspection-only and currently Claude-only. It has no shell,
  and recursive directory inspection is denied. It cannot edit,
  write, access bridge or other MCP tools, browse the network, ask the human,
  apply a utility patch, commit, push, merge, deploy, or create descendants.
- Governess is the only grant authority. Bridge submission, hook consumption,
  provider lifecycle observation, and pane rendering are adapters around its
  durable lease state.
- One slot is run-wide and currently available only to Claude. Codex remains
  eligible for the utility tiers but not native spawning until its provider can
  enforce a child sandbox narrower than the writable parent.
- Leases are requester-, epoch-, profile-, scope-, and time-bound, are consumed
  at most once under a file lock, and expire immediately when the Governess
  epoch advances.
- Missing manifests, malformed journals, stale epochs, unknown modes,
  protected scopes, symlink escapes, missing utility evidence, or hook errors
  deny a native spawn. Ordinary non-native hook telemetry remains best-effort.
- This slice does not restart or hot-swap any live Claude or Codex pane.

## Non-goals

- Replacing Direct, Nanny, Au Pair, Pi, or the deterministic task router.
- Allowing native children to author or apply patches.
- Turning native fallback into a second worker pool.
- Automatically choosing architecture, product, release, credential, remote,
  destructive, migration, or human-authority work for a child.
- Reconfiguring user-global Claude or Codex settings.
