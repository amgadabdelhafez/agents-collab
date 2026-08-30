# Plan: Deterministic workflow replay corpus

1. Define JSON-safe fixture steps and expected terminal observations.
2. Define a narrow replay-runtime seam around the existing engine-neutral
   `WorkflowPort`; keep restart/upgrade/clock mechanics outside the port.
3. Implement one runner that rebuilds the coordinator at restart and upgrade
   boundaries, records normalized receipts/projections/history/deliveries, and
   computes canonical structural digests.
4. Add the SupervisorMessage corpus for duplicates, crashes, delayed claims,
   cancellation, retries, exhaustion, and upgrades.
5. Implement a reference replay runtime over `InMemoryWorkflowPort` where the
   port represents durable engine state and coordinator instances represent
   disposable workers.
6. Prove two fresh complete runs are byte-for-byte deterministic and add
   negative runtimes that lose state or duplicate delivery.
7. Run focused tests, full CI, type check, build, engine-import scan, and diff
   check; freeze and independently review the exact candidate.
