# Loop 57 Runtime Fixes

## Problem

Lower-tier routing is present but unreliable. A queued Nanny retry can collide
with its own journal event and abort a Governess tick; Au Pair can be terminated
by several failed sibling tools from one model turn; exact safe Git plans are
sent through a model and lose order; helper results accumulate in the bridge;
Governess can summarize an idle composer placeholder instead of the real task;
and the requested bottom Recon row is absent.

## Required behavior

1. Retrying the same pending-route decision is idempotent, while a changed event
   with the same deterministic id remains an error.
2. Nanny capacity never prevents eligible Au Pair work from being considered in
   the same tick.
3. Pi broker rejection limits count model rounds. Every failure reports the
   exact broker code and message.
4. Fully structured, allowlisted Git/read plans execute Direct without model
   reconstruction; malformed or broadened plans fail closed.
5. A main agent's next `route_task` response atomically includes older,
   unclaimed utility results addressed to that agent. Peer messages are not
   consumed.
6. Governess Objective is derived from current-session human instructions, not
   terminal placeholders or prior-session summaries.
7. The tmux layout is `Claude | Codex`, then `Governess | Nanny/Au Pair`, then
   read-only `Recon 1 | Recon 2 | Recon 3`; Recon viewers expose route, tool, and
   result/bridge truth without owning any runtime decisions.

## Safety constraints

- No new provider proxy or permission widening.
- Nanny and Au Pair remain read-only/proposal-only.
- Exact Git support is limited to existing parsed inspection actions.
- Recon availability must never affect routing or delivery.
- Live rollout must preserve Claude and Codex pane ids and processes.
