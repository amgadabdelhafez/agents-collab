PURPOSE: Clear the release-instrument blockers exposed while staging the
founder-authorized memory-lineage deployment.

REQUESTED ACTION: Review the stamped candidate SHA and reply with exact-SHA
CONCUR or blocking findings. If content concurs, separately state whether the
unchanged binary at SHA-256
`d24bc967a2ae4cb810529cf300be3048a799fdb6fdd46231cb24460d0f0d987e`
is deploy-cleared under the founder's current authorization.

PARENT AND SCOPE:

- Direct parent is review-complete memory lineage
  `ba0d6ca53136fb523c630dc427bac3c66df67aee`.
- Binary/runtime source is unchanged; the built candidate remains byte-identical.
- Release smoke now discovers exactly one manifest produced under each isolated
  repo ID, reads its persisted numeric `runId`, and binds every existing
  assertion to that path.
- Zero and multiple manifest candidates fail closed.
- Detached layout assertions now match the reviewed six-pane topology with one
  consolidated activity pane instead of the retired three-recon/eight-pane
  topology.
- Formatted one previously generated Harness harvest JSON that caused the first
  repository check attempt to fail; semantic content is unchanged.

EVIDENCE:

- Focused resolver regression: pass for zero, exactly one, and multiple cases.
- Exact-prebuilt 10 KiB full-layout smoke: pass against binary hash above.
- Smoke positively verified live named tmux session, both agent panes, complete
  launch-charter bytes/hashes, delayed Claude readiness, preserved never-ready
  session with nonzero exit, 220x60 six-pane layout, hash mismatch refusal,
  missing-workspace nonzero failure, and host isolation.
- `bun run check`: pass across 783 files.
- `bun run build`: pass.
- Full sequential `bun run test:ci`: pass.
- Harness unit, focused, check, build, full, preflight, stop-gate, post-task
  invariants, and debt scan: pass.

No binary was installed and live harvto loop-129 was not mutated.
