# Verification

- A declared absent write file appears as `state: new` in the hashed context capsule.
- Searching that exact file returns `ok: true` with no matches.
- At the original `au-pair-new-file` SHA, an absent read-only path returned
  `not_found`. The later `utility-search-empty-boundary` contract supersedes
  that behavior only for safely bounded searches; out-of-scope absence remains
  `scope_denied`, and `read_file` remains `not_found`.
- A new-file unified diff is stored as a guarded proposal with a null preimage and does not create the file.
- Focused utility tests, `bun run check`, `bun run build`, and the repository verification gate pass with an empty baseline failure list.
