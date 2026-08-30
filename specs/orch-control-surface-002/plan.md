# Plan: authenticated orchestration control surface

1. Add a small task-graph runtime over the generic WorkflowPort.
2. Bind authenticated identity into message and graph mutations.
3. Expose exact routes for graph lifecycle and existing durable read models.
4. Prove authorization, identity anti-spoofing, DAG refusal, readiness, and
   non-leaking errors in memory and on Temporal.

