# Plan: Supervisor orchestration runtime

1. Add a generic runtime that composes the governed service and durable store.
2. Persist each successful canonical projection with a stable operation-scoped
   request ID and immutable message category.
3. Expose fresh durable thread-board, Attention, and knowledge snapshots.
4. Add a Temporal host that starts one real worker and injects the accepted
   Temporal adapter into the generic runtime.
5. Prove restart, replay, denial, persistence-before-success, fresh reads, and
   worker lifecycle with focused tests, including a real ephemeral Temporal
   server.

