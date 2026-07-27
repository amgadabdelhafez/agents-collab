# Integrated safe worker routing

## Problem

Loop 53 recorded 351 skipped tool observations. The snapshot mixed 189 tools
that were intentionally outside worker authority, 95 compound Bash commands,
25 events from an unverified temporary workspace, and smaller grammar gaps.
Within the compound bucket, 59 were read-only command chains that can be
represented without granting a shell.

The live release is also internally inconsistent. The active governess has the
broader classifier loaded from a previous binary, while the installed binary
contains the separate four-slot and runaway-guard work but not the broader
broker. A newly spawned worker can therefore expose fewer tools than the live
classifier expects.

## Requirements

- Ship one binary containing the completed broader classifier/broker,
  contention-safe claims, four-slot default, and runaway circuit breakers.
- Add a `read-plan` execution profile for two to six literal read-only stages.
  Each stage must independently match an existing safe classifier and the
  runtime must expose exactly that stage's single broker tool, scopes, exact
  read boundary, and output boundary until the stage succeeds.
- Permit a single verified leading `cd`, exact `&&` separators, and the
  existing exact stderr/head/tail output forms. Reject semicolons, arbitrary
  pipes, command substitution, variables, glob expansion, redirects, loops,
  interpreters, mutation, network, and process control.
- Add bounded mappings for one-to-four-file `cat`/`cat -n`, empty-pattern
  `grep -n "" <file>` as a file read, multi-directory `ls` as repeated
  nonrecursive listings, and verified linked-worktree leading `cd` targets.
- Preserve literal-grep restrictions. Do not broaden arbitrary regex or shell
  execution.
- Split routing observability into actionable misses, intentional retains, and
  unsafe rejects. Historical events without a category must be classified by
  their existing disposition/reason.
- Keep raw reason counts for diagnosis while removing intentionally retained
  control/UI tools from the alarming skipped total shown to operators.
- Preserve no token/dollar budget, the 15-minute runtime reaper, four worker
  slots, three-denial breaker, third-identical-call breaker, and 64-model-call
  emergency ceiling.

## Non-goals

- General shell, Python, Node `-e`, heredocs, file redirection, or executable
  paths selected by the model.
- Automatic direct `Edit`/`Write`; bounded worker edits remain reviewed patch
  proposals.
- Browser/computer control, loop bridge orchestration, agent spawning,
  monitoring, file delivery, or user-visible external actions.
- Git mutation/remote commands, dependency changes, package installation,
  destructive commands, or access outside verified repository/worktree roots.
- Shopify/KB credential proxies in this release. Those require a separately
  specified read-only secrets/proxy boundary.

## Acceptance

- The integrated binary exposes `list_files`, `git_inspect`, focused checks,
  four slots, and all three runaway breakers.
- Safe two-to-six-stage read plans classify and persist as `read-plan`; each
  unsafe near-neighbor fails closed before a job is created.
- Compound plans cannot expose a cross-product of read tools/scopes, cannot
  expose `run_check` or `propose_patch`, cannot cross stage boundaries, and
  cannot complete before every structured stage succeeds.
- Bounded cat, empty-pattern file reads, multiple directory listings, and
  linked-worktree leading `cd` cases have red-first regressions.
- Observability reports routed, actionable, retained, unsafe, and pending
  counts with legacy-event compatibility and exact reason totals.
- Focused suites, full suite baseline comparison, build, diff check, Harness
  eval, and an independent evaluator pass.
- Atomic deployment restarts only the loop-53 governess pane, preserves every
  other pane PID/layout, loads one coherent executable, and leaves doctor green.
