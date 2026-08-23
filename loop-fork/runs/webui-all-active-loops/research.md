# webui-all-active-loops Research

## Research Question

What existing repository code and platform primitives should be reused to
discover and serve multiple active loop runs safely?

## Candidates Reviewed

- Node.js `readdirSync(..., { withFileTypes: true })` and `Dirent`: fits
  bounded direct-child discovery and file-type rejection without adding a
  traversal dependency. It still requires explicit entry-count, name, symlink,
  containment, and stable-read checks.
- Vite `configureServer` and `configurePreviewServer` middleware hooks: the
  existing same-origin endpoint already uses the supported development and
  preview integration points, so the transport layer can remain unchanged.
- Existing `harvto-live-data.ts` stable UTF-8 reads, strict JSON/JSONL
  parsing, tmux exact-session probe, redacted DTO builders, and client schema
  validator: these already enforce the task's hardest safety boundaries and
  should be generalized rather than replaced.

## Open-Source Patterns

Use typed directory entries instead of string-only recursive walking; validate
each identity at the trust boundary; cap collection sizes before reading; isolate
per-item failures so one bad record does not erase good records; aggregate only
validated projections; and keep the HTTP middleware thin.

## Reuse Decision

Adapt the existing live projector in place. Add a bounded repository/run
discovery layer, extract one-run projection, add a manifest-only degraded
projection, then aggregate results. Keep the current Vite plugin, endpoint,
polling client, DTO redaction, and runtime probe. No library or service is
needed.

## Sources

- https://nodejs.org/api/fs.html#fsreaddirsyncpath-options
- https://vite.dev/guide/api-plugin.html#configureserver
