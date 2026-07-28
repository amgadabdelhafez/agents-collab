# Audience-aware Loop communication

## Problem

Caveman removes filler effectively, but compression alone does not tell an
agent which information belongs first. Human-facing updates can still begin
with process narration, while peer review and handoff messages can become too
compressed for reliable machine review.

The upstream `ayghri/i-have-adhd` skill provides useful action-first output
rules, but applying its complete ruleset to every Loop channel would be unsafe:
its five-item cap, tangent suppression, and aggressive brevity can discard the
evidence and exceptions required by internal reviewers.

## Required outcome

1. Human, founder, and external-supervisor updates lead with the result,
   decision, blocker, or exact action required.
2. Human-facing progress makes the current state visible and ends with at most
   one concrete ask when input is genuinely required.
3. Human-facing errors state location or failed operation, cause, and next fix
   without emotional filler.
4. Bridge, review, and handoff messages remain evidence-dense: purpose/request
   first, followed by exact scope, claims, commands/results, risks, unknowns,
   and the requested decision or next action.
5. Internal evidence has no arbitrary item cap. Caveman may compress connective
   prose but must not remove exact evidence or reasoning required for review.
6. The policy applies to tmux and foreground paired flows, plan/work/review
   prompts, and Claude channel instructions without changing bridge schemas,
   routing authority, tool permissions, or delivery behavior.
7. Guidance identifies the upstream repository and reviewed commit so the
   adaptation is auditable.

## Non-goals

- Do not install or enable the complete upstream plugin globally.
- Do not diagnose or infer ADHD.
- Do not force numbered steps, time estimates, or a five-item cap on internal
  agent traffic.
- Do not rewrite, truncate, or normalize bridge payloads in transport code.
- Do not restart an active loop, reinstall the global runtime, or push remotely.
