# Useful utility routing

Authorized 2026-10-04 by the human: relax routing guidance, use Nanny and Au Pair
more effectively, and compare Bifrost with modern upstream routers.

One driver remains the repository writer and acceptance owner. Au Pair may
propose bounded patches regardless of the driver's provider. Proposal generation
does not grant apply authority. Existing exact scopes, conflicts, freshness,
epoch, review and guarded apply checks remain. Nanny handles small exact reads,
searches and profiled checks; Au Pair handles cohesive multi-file evidence and
scoped patch proposals. The driver keeps ambiguous/sequential decisions.

Delegation is an optimization, not an obligatory quota. Use a helper when it
removes useful independent work from the critical path. Do not manufacture tiny
packets or block a trivial edit waiting for a helper. No repeated refusal retries.

Provider routing stays outside task routing. OpenRouter is a provider, not an
automatic model selector. Exact model aliases, explicit fallback lists, per-task
budgets and cancellation belong to a selected upstream gateway. Temporal owns
durability; the bridge owns task/result transport; the driver owns acceptance.

Acceptance: a Codex-primary bounded edit queues without touching repo files;
unbounded packets still refuse; guidance describes proposal-only authority and
useful delegation. No gateway deployment or live cutover in this source slice.

Base: verified installed feature lineage 553d803f, not the older origin/main
dde60215. This preserves newer utility broker contracts. The stats/API repair
is retained in the combined installed release recorded in
`loop-fork/runs/utility-routing-composed-release/status.md`.
