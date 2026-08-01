# Plan: Codex Proxy Lifecycle Hardening

1. Add raw-WebSocket regression tests for fragmented text and upgrade-response
   byte preservation, then implement protocol-compliant reassembly.
2. Make tmux-death cleanup require consecutive authoritative `dead` probes and
   reduce the synchronous control-plane polling frequency.
3. Replace terminal reconnect exhaustion with bounded ongoing retry while the
   run remains active and add an integration test that crosses the old limit.
4. Add a run-scoped, secret-safe proxy lifecycle journal and exact stop reasons.
5. Run focused and full verification, create the task eval, commit the branch,
   and hand the exact SHA to the supervisor for integration review. Do not
   deploy or touch the live run.
