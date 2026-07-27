# Nanny bounded inspection routing

## Problem

The Pi control plane is live, but Nanny receives no utility jobs. Exact reads
correctly bypass models through Direct, while every unprofiled inspection is
currently sent to Au Pair solely because it lacks structured execution
metadata. Live Loop 56 evidence showed safe single-file inspection requests in
that gap.

## Goal

Allow local Qwen through Nanny to own a narrow class of low-risk, read-only,
unprofiled inspections. Preserve one-owner routing and every existing broker,
workspace, protected-path, capacity, and runaway boundary.

## Requirements

1. Keep Direct first: any request with complete direct tool arguments remains
   `utility-direct` and makes no model call.
2. An unprofiled request may route to `utility-nanny` only when all of the
   following hold:
   - kind is `inspect` and risk is `low`;
   - write scope is empty and no authority flag is true;
   - required capabilities contain only `inspect`;
   - one or two read scopes are declared;
   - at most two context references are declared;
   - one to four acceptance criteria are declared; and
   - the objective plus acceptance criteria are at most 6,000 characters.
3. Unprofiled commands, edits, reviews, focused verification, bounded-command
   capability, authority, three-or-more-scope investigations, and oversized
   requests do not enter Nanny's band.
4. Existing profiled Nanny eligibility remains unchanged except for explicit
   low-risk and authority checks as defense in depth.
5. Nanny still receives only Pi's broker-backed tools, no built-ins, no write
   capability, one ephemeral session, one local slot, and existing rejection,
   repetition, tool-call, model-call, cancellation, and runtime fuses.
6. A Nanny failure or full slot never falls through to Au Pair automatically.
7. Persist and display `utility-nanny`, `Nanny`, provider/model, Pi version,
   usage, tool events, and final status exactly as for current Pi jobs.

## Acceptance

- Pure classification tests cover live-shaped single-file and two-scope
  unprofiled inspections entering Nanny.
- Boundary tests keep Direct, commands, edits, reviews, verification,
  authority, broad scopes, excess context, and oversized requests out.
- Runtime routing proves the chosen Nanny tier is persisted before claim and
  no Au Pair fallback occurs.
- Focused tests, full `bun test`, build, `git diff --check`, Harness gates, and
  repository verification pass.
- Independent evaluation records PASS before live installation.
- Live rollout preserves Claude and Codex PIDs and demonstrates at least one
  harmless Nanny-routed inspection with Pi usage evidence.

## Non-goals

- Expanding command grammar or compound-command decomposition.
- Moving exact reads/checks away from Direct.
- Giving Nanny edit, patch, review, design, release, remote, destructive,
  credential, dependency, or product authority.
- Restarting Claude or Codex.
