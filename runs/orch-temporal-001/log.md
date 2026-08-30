# ORCH-TEMPORAL-001 log

- 2026-08-30T04:10:00Z: Created isolated branch `codex/orch-temporal-001` from
  independently accepted replay-corpus closure
  `aa6bff5c11d478ff8d15aee702c6903aa7e7fab4`.
- 2026-08-30T04:11:00Z: Bound the Temporal adapter contract before dependency or
  source mutation. Current official npm package line is 1.23.0 and supports the
  installed Node 26 runtime. No production Temporal service is in scope.
- 2026-08-30T04:13:00Z: Added exact Temporal 1.23.0 client, testing, worker, and
  workflow packages. Implemented the Temporal workflow, engine adapter, and
  ephemeral replay runtime without exposing SDK types through `WorkflowPort`.
- 2026-08-30T04:15:00Z: The first focused run exposed two concrete runtime
  mismatches: `structuredClone` is unavailable in the workflow sandbox, and the
  shared test clock was not reset at fixture boundaries. Replaced cloning with
  JSON-safe serialization and reset the injected clock for each frozen case.
- 2026-08-30T04:21:02Z: Focused Temporal conformance passed 3/0. The unchanged
  six-case corpus ran twice on two fresh Temporal CLI 1.8.2 / Server 1.31.2
  in-memory servers and matched aggregate digest
  `5f1bd79af5217d60339a50996d6f3bc04c6f745e9a0c2a832d09cfe0caf8abdd`.
  Worker stop/restart and the distinct `supervisor-message.v2-worker` identity
  were positively observed.
- 2026-08-30T04:21:02Z: `bun run check`, compiled `bun run build`,
  `git diff --check`, and the repository-certified full `bun run test:ci`
  completed with empty named failure sets. The Temporal worker emitted only the
  SDK's Bun-version deprecation warning; no resource or test failure remained.
- 2026-08-30T04:25:00Z: Froze exact candidate
  `d143fad1bb3d7c61f4f461cf8f33df4d32513f23`. A separate Claude CLI reviewer
  routed through OpenRouter `z-ai/glm-5.2` at low effort returned literal PASS
  after independent committed-object inspection and made zero project-tree
  writes. ORCH-TEMPORAL-001 is accepted; engine selection remains pending the
  same frozen corpus on DBOS.
