# Harvto Supervisor Next Phase

Last updated: 2026-08-20

## Current state

D1 through D10 and the related D13 through D16 campaign work are complete on
the published feature stack. D11 and D12 remain specifications only. Neither
has implementation, red proof, an implementation commit, or a release verdict.

## Phase 1: integrate the completed stack

1. Open the order-01 pull request against GitHub `main`.
2. For each later branch, open a pull request against the immediately preceding
   stack branch.
3. Require each pull request to show only its documented commit range.
4. Run the mandatory checks on every proposed merge tip. Do not infer an
   intermediate branch result from the green order-13 tip.
5. Merge in numeric order. If a slice is rejected, stop at its predecessor and
   rebase no later branch until the governing decision is recorded.

Exit condition: order 13 is reachable from GitHub `main`, with order 14 merged
after the code stack or carried as the final documentation-only change.

## Phase 2: D11 composer-safe recovery

Objective: recover a stalled paired run without changing or submitting either
agent's non-empty composer and without issuing a duplicate nudge.

Required sequence:

1. Promote D11 exactly once from the parked specification.
2. Record an isolated activation proof before changing tests or source.
3. Trace the production recovery path and freeze exactly five canonical
   contracts.
4. Obtain the required plan verdict before tests, red proof, source changes, or
   evaluation staging.
5. Capture a genuine durable red case with both composers non-empty.
6. Implement recovery with no hidden keystroke mutation and no duplicate
   notification.
7. Run the full mandatory gate set with an empty named baseline-failure set.
8. Obtain an exact-SHA implementation verdict, close once, and make lifecycle
   bookkeeping a separate commit.

Acceptance properties:

- both composer byte sequences are unchanged;
- no Enter, Escape, clearing, submission, or cursor mutation is injected;
- one recovery event causes at most one nudge;
- restart or retry remains idempotent;
- missing delivery evidence fails closed.

## Phase 3: D12 manifest-backed socket discovery

Objective: discover and inspect paired tmux sessions through the persisted run
manifest instead of assuming the default tmux socket.

Required sequence:

1. Keep D12 parked until D11 is fully closed and its bookkeeping verdict has
   passed.
2. Promote D12 exactly once.
3. Define manifest identity, socket, session, PID, freshness, and ownership
   contracts before implementation.
4. Add red cases for a non-default socket, a missing manifest, malformed
   identity, a stale session, and an ownership mismatch.
5. Make discovery read-only and topology-independent.
6. Fail closed on malformed, missing, stale, or contradictory state.
7. Prove default-socket behavior remains compatible without making it the
   source of truth.

Acceptance properties:

- the manifest is the sole discovery authority;
- non-default sockets are visible and inspectable;
- stale sessions are not treated as live;
- no discovery command recreates, attaches, signals, or tears down a session;
- D12 cannot mutate D11 evidence or lifecycle state.

## Phase 4: repository hygiene

After the stack is remote and exact tips are verified:

1. remove duplicate campaign worktrees while retaining one local evidence copy;
2. delete alias branches that point to the same retained remote commit;
3. remove clean worktrees whose branches are already reachable from GitHub
   `main`;
4. preserve every dirty or untracked worktree until its unique state is
   classified;
5. run the safe worktree reaper in audit mode, then explicit apply mode;
6. report the remaining exception set instead of forcing deletion.

The repository is clean only when every remaining worktree has an active
purpose and every remaining local branch is either checked out, published, or
named as a deliberate archive.
