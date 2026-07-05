# Constitution
> Non-negotiable rules. Everything else is advisory.
> Specs, plans, and tasks must not contradict anything here.

## Purpose

This document defines the permanent constraints for all work in this repo.
Agents and humans must read it before producing any spec, plan, or implementation.

---

## Quality bar

- No feature ships without a passing `eval.json` in `runs/<task-id>/`.
- No UI change ships without screenshot + DOM assertions in the eval.
- No PR merges if `docs/quality/quality-scorecard.md` grades the touched subsystem as **D or F** without a remediation task tracked in `specs/`.

## Architecture invariants

_(Fill in your actual invariants. Examples below.)_

- Services must not import directly across bounded-context boundaries; use declared interfaces.
- No secrets in source. Credentials are proxied through the secrets layer, never accessed directly by agents.
- All external I/O is observable: every outbound call must emit a trace span.
- The dependency map (`docs/dependency-map.md`) must be accurate at time of merge.

## Agent operating rules

- Start from spec, not chat. `specs/<feature>/spec.md` is required before any implementation task.
- Worktree isolation is mandatory for every non-trivial task.
- The evaluator agent must be different from the implementation agent (no self-review).
- Replayable evals are required before any background maintenance agent is promoted to production.

## Prohibited actions

- Broad permission grants (never `chmod 777`, never open network to `0.0.0.0` in production).
- Mutating protected paths without an approved spec. Protected: `specs/constitution.md`, `docs/architecture/invariants.md`.
- Skipping `scripts/verify.sh` to "save time."

## Amendments

Amendments require a spec with human approval. Log changes at the bottom of this file with date and summary.

---

_No amendments yet._
