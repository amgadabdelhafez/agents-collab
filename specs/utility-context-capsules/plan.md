# Plan

1. Add red tests for protected project instructions, context-ref validation,
   deterministic capsule construction, runtime prompt delivery, replay
   persistence, and context-insufficient escalation.
2. Add a provider-neutral context capsule module with strict byte/character,
   path, realpath, file-type, and aggregate limits.
3. Extend route requests and `route_task` with normalized `contextRefs`, keeping
   legacy jobs valid and idempotency deterministic.
4. Compose the immutable system contract, trusted project instructions,
   untrusted selected references, and exact task packet for every provider
   turn; persist version/hash and the capsule snapshot under the run.
5. Record context metadata on compact results and usage. Classify the explicit
   context-insufficient sentinel as one escalated job and surface only its count
   and bounded blocker in observability.
6. Add the repository's `UTILITY.instructions.md`, refresh dependency docs,
   run focused/full verification, obtain independent evaluation, commit, and
   atomically install for future loops.
