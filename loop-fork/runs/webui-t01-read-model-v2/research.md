# webui-t01-read-model-v2 Research

## Research Question

Which existing Loop readers and standard runtime primitives can build a
canonical, revisioned, side-effect-free fleet/run/timeline projection without
reusing maintenance or heuristic authority?

## Candidates Reviewed

- **T-00 manifest and transcript readers.** `readRunManifest` now provides a
  strict exact-byte revision and preserves legacy identity/config absence.
  `readRunTranscriptEntries` is read-only but lacks a source revision, so T-01
  must bind the parsed rows to a separately captured exact file revision.
- **Bridge store readers.** `readBridgeEvents`, `readBridgeStatus`, and
  `readBridgeQueueHealth` contain useful parsing and resolution semantics, but
  the same module also exports append, acknowledge, notification, and cleanup
  operations. The control surface should inject a narrow read capability and
  must not import the module as an authority bundle.
- **Governess journal readers.** `readGovernessJournal`, latest-record reducers,
  and storage inspection are reusable concepts. `ensureGovernessJournalIndex`,
  compaction, maintenance, reconciliation, and transition functions are unsafe
  for GET paths and remain outside the capability interface.
- **Utility observability.** `readUtilityObservability` already materializes
  bounded job, tool, context, failure, performance, and usage views from
  run-owned files. T-01 consumes it through injection and redacts the resulting
  public DTO rather than importing utility execution/store functions.
- **Current panel and Harvto live-data code.** These are useful discovery and
  migration references, but not canonical authority: they join runtime probes,
  default tmux/process observations, and older DTO assumptions. T-01 keeps
  durable run identity producer-owned and labels adapter probes as diagnostics.
- **Node filesystem and crypto primitives.** `readFileSync` supplies exact bytes,
  `statSync` supplies bounded metadata, and `createHash('sha256')` supplies
  deterministic revisions without adding a database, watcher, or dependency.

## Open-Source Patterns

- Snapshot each source as `{value, revision, observedAt, quality}` and compose
  only snapshots whose revisions remain stable. Re-read revisions once after
  materialization; retry the whole run once, then report instability.
- Keep durable requirements separate from observations. Missing evidence is
  unknown, not false or healthy, and aggregate status follows a versioned table.
- Treat identity and containment as admission checks. A manifest whose IDs do
  not match its selected path is rejected before it can create a canonical run.
- Give clients opaque evidence handles derived from canonical run key plus
  source kind and bounded locator; resolve only through a containment-checked
  server-side map in a later HTTP slice.
- Bound every file, row count, string, and timeline page before parsing or
  rendering. Redact at the projection boundary, not in React.
- Expose freshness thresholds and source provenance in DTOs and test boundary
  behavior with an injected clock.

## Reuse Decision

Build a small new control-surface layer around narrow injected read
capabilities. Reuse T-00 manifest/transcript types and producer semantics, and
adapt bridge/Governess/utility output shapes through type-only boundaries.
Implement exact-byte file snapshots with Node built-ins. Do not import panel,
maintenance, execution, append, migration, or default-tmux functions, and do
not add a framework or package.

## Sources

- https://nodejs.org/api/fs.html
- https://nodejs.org/api/crypto.html
- `runs/webui-control-plane-spec/research.md`
- `src/loop/run-state.ts`
- `src/loop/bridge-store.ts`
- `src/loop/governess-journal.ts`
- `src/loop/utility-observability.ts`
- `src/loop/panel.ts`
- `src/webui/server/harvto-live-data.ts`
