PURPOSE

Request exact-SHA review of Project World Model Phase 0. This is an evidence-only, local SQLite projection that grounds later loop decisions without acquiring authority over routing, permissions, releases, deployments, or lifecycle actions.

REQUESTED ACTION

Review the exact candidate SHA stamped by the governed sender. Reply CONCUR or provide blocking findings. No deployment clearance is requested.

LINEAGE

- Required parent and currently deployed cleared tip: `cca045a7ff7b925f4559732ae4968d851b3e6db6`
- Candidate: supplied and verified by `evals/release/send-stamped-review.sh`

SCOPE

- Versioned ontology, fail-closed validation, temporal statements, contradictions, and bounded context capsules.
- Deterministic materialization from committed Git blobs only, with exact evidence hashes and provenance.
- Explicit candidate and assertion ingestion that cannot manufacture producer observations.
- Local `loop world build`, `ingest`, `context`, and `ontology` commands.
- Specification, producer-backed regression tests, and harness evidence under `runs/project-world-model/`.

PROOF

- Final sequential `bun run test:ci`: exit 0, including 10 world-model tests.
- `bun run check`: pass across 796 files.
- `bun run build`: pass.
- `./harness preflight --json project-world-model`: pass.
- `./harness stop-gate --json project-world-model`: pass.
- Repeated deterministic build test proves identical graph and capsule hashes from the same committed producer state.
- Changed-commit test proves new evidence binding; explicit assertions survive deterministic projection replacement.

LIMITS

- Phase 0 is local and query-only for agents; it does not automatically inject context or drive policy.
- Repository-wide `tsc --noEmit` retains pre-existing baseline errors. No error references the new world-model source or tests, and the production compile succeeds.
- The older wrong-base exploratory worktree remains preserved and is not part of this candidate.
