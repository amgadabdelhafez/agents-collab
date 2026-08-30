# Plan: governed SupervisorMessage delivery

1. Define engine-neutral authority, trusted route-directory, and governance
   receipt ports with closed operation and reason vocabularies.
2. Wrap `SupervisorMessageCoordinator` so authorization precedes every
   state-changing application operation and denied calls fail before mutation.
3. Implement a bridge delivery adapter over `dispatchBridgeMessage` using only
   trusted route resolution and the workflow's exact idempotency key.
4. Add focused tests with isolated run directories and the accepted in-memory
   reference port; verify exact bridge events and body-free receipts.
5. Run one focused gate, one full suite, static/build/diff checks, freeze one
   exact candidate, and obtain independent zero-write review.
