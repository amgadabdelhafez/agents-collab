# Plan: Loop orchestration integration

1. Add strict manifest-backed supervisor route discovery and tests.
2. Add a run-owned orchestration service factory around the reviewed Temporal
   host, bridge adapter, durable stores, authority, and HTTP handler.
3. Add a strict Harness DAG document parser and start adapter.
4. Expose the Temporal worker as a dedicated source-run service entrypoint so
   Temporal's bundler dependencies are not pulled into every compiled Loop CLI.
5. Prove delivery, claim/ack, restart durability, dependency refusal/readiness,
   health redaction, fail-closed startup, and a pull-consumption boundary that
   cannot mistake app-server acceptance for acknowledgement.
6. Run focused tests, the full named suite, static/build/diff gates, freeze one
   exact candidate, and obtain independent zero-write review before activation.
