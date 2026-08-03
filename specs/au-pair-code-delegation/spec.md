# Spec: Au Pair small-code delegation

## Problem

Loop 60 proves that the Au Pair runtime is healthy but starved: 16 submitted
packets produced 12 Nanny jobs, one Direct job, two driver returns, one human
escalation, and zero Au Pair jobs. Every eligible packet was shaped as an
inspection. The shared guidance mentions patch proposals but does not tell a
main agent to delegate a self-contained code change before authoring it, define
`risk` as operational rather than intellectual risk, or reserve the exact
write scope while the proposal is in flight.

## Goal

Move meaningful small code-writing tasks from Claude and Codex to Au Pair/GLM
without making GLM a primary agent or widening its authority. Main agents keep
intent, architecture, review, patch application, and final verification.

## Required behavior

1. Before authoring a self-contained implementation block, a main agent routes
   it as `kind: "edit"` when all of these are true:
   - the desired behavior and acceptance criteria are already decided;
   - one or two exact files may change and at most four exact files are needed
     as read context;
   - no product, architecture, dependency, migration, release, credential,
     remote, destructive, or human-authority decision remains;
   - the agent can reserve the declared write files while the job is active.
2. Useful edit packets include a helper function, parser/validator branch,
   bounded adapter, focused regression fixture, or similarly cohesive code
   block. Trivial token substitutions and cross-cutting changes stay with the
   main agent.
3. A bounded patch-proposal request is `risk: "low"` even when its reasoning is
   non-trivial, because `risk` describes operational side effects and authority,
   not model difficulty. Ambiguous scope or unresolved design is not relabeled
   low merely to obtain a helper route.
4. Edit packets use exact read/write scopes, default edit capabilities
   (`inspect` and `scoped-edit`), and concrete acceptance criteria. They are not
   disguised as inspection packets.
5. The main agent continues non-overlapping critical-path work, does not edit a
   claimed write scope, and reviews the returned patch artifact before using
   the guarded full-agent-only apply tool.
6. Governess remains the deterministic owner. `kind: "edit"` selects Au Pair
   only after ordinary epoch, boundedness, low-risk, authority, protected-path,
   health, and write-conflict gates pass.
7. Au Pair remains proposal-only. It cannot apply, commit, push, merge, deploy,
   install dependencies, access credentials, or message the human.
8. Startup prompts, Claude channel instructions, and the `route_task` tool
   schema carry the same compact small-edit and risk semantics.

## Safety boundary

- A utility edit must declare one or two write scopes, one through four read
  scopes, and include `scoped-edit` capability.
- Empty, directory-broad, protected, secret-like, unverified-worktree,
  overlapping, medium/unknown/high-risk, or authority-bearing requests fail
  closed or stay with the requester.
- No automatic interception of `Write` or `Edit` tool calls is added; once a
  main model has authored the payload, rerouting it cannot save model work.
- No model may request a provider or tier directly.

## Non-goals

- Delegating architecture, peer-review verdicts, product decisions, broad
  refactors, or the original human task. Au Pair may perform bounded,
  non-authoritative evidence audits for a main-agent review.
- Automatically applying generated patches.
- Giving Au Pair a shell, native agent tools, or persistent chat context.
- Weakening risk or protected-path gates to increase utilization.
- Restarting the active Loop 60 Claude or Codex panes.
