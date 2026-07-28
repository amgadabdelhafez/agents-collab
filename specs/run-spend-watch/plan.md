# Plan — run-level spend watch

1. New module `src/loop/governess-spend.ts`, pure and dependency-light so it is
   testable without a live run:
   - `resolveSpendConfig(env)` — thresholds + mode, defaulting to `observe`.
   - `readBillableSpendUsd(runDir)` — latest `usage.cost` per `jobId` from
     `utility/usage.jsonl`, tolerant of malformed lines.
   - `recordSpendSample` / `burnUsdPerHour` — bounded sliding window over
     cumulative billable spend.
   - `evaluateSpend(snapshot, config, history)` — returns a `SpendDecision`
     carrying `level`, `killRequested`, `enforced`, and a human reason.
   - `spendEscalations(decision, notified, runId)` — `EscalationEvent[]`,
     deduped per level via a caller-owned `notified` record.
   - `appendSpendJournal(runDir, decision)` — one JSON line per evaluation.
2. Separation of concerns kept deliberate: the module decides, the caller acts.
   Nothing here touches `task-router.ts` or `utility-runtime.ts`, so no code
   path can regain the ability to fail a job mid-flight.
3. Tests in `tests/loop/governess-spend.test.ts`, TDD, with the safety
   properties (observe cannot enforce; one expensive job cannot kill;
   subscription spend cannot kill) asserted directly.
4. Leave the existing dead `budgetUsd` escalation untouched — its tests pass and
   removing it is a separate call for the supervisor.

## Deliberately not done

- No wiring into the live `governessTick`. Loop 56 is running against this
  binary's lineage; adding a new call into the tick path is a behavioural change
  that belongs behind the founder's own merge, after observe-mode data exists.
  The module is complete and tested; activation is one call site.
