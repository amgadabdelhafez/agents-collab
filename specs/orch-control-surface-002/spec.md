# Spec: authenticated orchestration control surface

Expose one embeddable authenticated Fetch handler for SupervisorMessage,
canonical task DAG, durable board/Attention, and knowledge references. Request
identity is authoritative for sender, claimant, and worker ownership. Graph
submission is refused by the canonical validator before Temporal creation.
Responses are bounded JSON with `no-store`; errors do not leak paths, bodies,
secrets, or engine details.

