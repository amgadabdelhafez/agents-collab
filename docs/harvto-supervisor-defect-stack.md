# Harvto Supervisor Defect Stack

Last updated: 2026-08-20

## Release decision

The completed Harvto supervisor campaign is published as a linear stack of
feature boundaries. The stack preserves the reviewed commits exactly. It is
not a set of branches independently rebased onto `main`.

This structure provides the lowest-conflict integration path:

- apply branches in numeric order, using the previous stack branch as the base;
- review only the commit range introduced by the current branch;
- roll back in reverse numeric order;
- never merge two stack branches independently into the same base;
- never push or merge directly to `main` from an automation or agent session.

The common base is GitHub `main` at
`0f69b9a99f9163bf9f83075530e26aed21258463`.

## Branch map

| Order | Branch | Tip | Commits in slice | Purpose |
|---:|---|---|---:|---|
| 01 | `codex/harvto-stack-01-workspace-ownership` | `1f58ba4c` | 4 | D2/D13 live workspace ownership and terminal-state coverage |
| 02 | `codex/harvto-stack-02-handover-composer-safety` | `52e244b8` | 5 | D14 durable handover and preservation of active composers |
| 03 | `codex/harvto-stack-03-live-peer-expiry` | `0822c354` | 6 | D1 live-peer retention, pane-probe fail-closed behavior, and utility-patch validation |
| 04 | `codex/harvto-stack-04-peer-verdict-protocol` | `d5d31408` | 4 | D4 peer-result reconciliation and required peer decision |
| 05 | `codex/harvto-stack-05-pending-route-fail-closed` | `6cdb9ad6` | 2 | D3 unowned utility-route rejection |
| 06 | `codex/harvto-stack-06-durable-supervisor-completion` | `ee559c4f` | 2 | D5 durable supervisor completion emission |
| 07 | `codex/harvto-stack-07-utility-scope-audit` | `fb71f47b` | 2 | D16 complete utility scope audits |
| 08 | `codex/harvto-stack-08-teardown-process-settlement` | `ee1e7736` | 2 | D15 settlement of owned teardown processes |
| 09 | `codex/harvto-stack-09-readonly-attach-evidence` | `2c415e12` | 5 | D6 read-only recovery attachment and formatter evidence scope |
| 10 | `codex/harvto-stack-10-handoff-launch-identity` | `66fd1e13` | 3 | D7 successor launch identity preservation |
| 11 | `codex/harvto-stack-11-stale-write-lease` | `18a59060` | 3 | D8 stale utility write-lease fencing |
| 12 | `codex/harvto-stack-12-bridge-ack-dedup` | `1282bd4c` | 4 | D9 resolved bridge acknowledgement deduplication |
| 13 | `codex/harvto-stack-13-guarded-patch-apply` | `546bfec4` | 3 | D10 guarded utility patch application |
| 14 | `codex/harvto-stack-14-next-phase-docs` | current branch | 1 | Release map, architecture notes, quality state, and next-phase plan |

## Verification state

The code tip `546bfec47b4702cdc6356a41be0dd5ff1f27ccf7` was verified from a clean
detached worktree after the campaign stopped:

- Biome checked 189 files without fixes;
- TypeScript checking passed;
- the production build completed across 3,051 modules;
- all 79 sorted test files passed;
- the D10 evaluation baseline allowlist was empty.

That proof certifies the complete stack tip. A pull request for an intermediate
branch must run its own required checks against that branch tip.

## Local cleanup policy

Worktree deletion and branch deletion are separate actions. A worktree can be
removed after its unique uncommitted state has been preserved or deliberately
discarded. A local branch can be removed only after its exact tip is visible on
GitHub or is proven reachable from another retained GitHub branch.

Runtime state, `.loop/`, frozen run evidence, and dirty `PLAN.md`/`status.md`
records are not product source. They must not be silently folded into a release
branch. Campaign evidence remains local until a separate evidence-retention
decision names what should be published.

The 2026-08-20 cleanup retained each dirty non-root worktree as a checksummed
local-only archive containing branch and HEAD identity, status, binary tracked
and staged patches, an untracked-file manifest, and a compressed untracked-file
snapshot. Raw run evidence remains outside Git history; only reusable product
decisions and follow-up candidates belong in this documentation branch.
