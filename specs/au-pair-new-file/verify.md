# Verification

- A declared absent write file appears as `state: new` in the hashed context capsule.
- Searching that exact file returns `ok: true` with no matches.
- Searching an absent read-only path still returns `not_found`.
- A new-file unified diff is stored as a guarded proposal with a null preimage and does not create the file.
- Focused utility tests, `bun run check`, `bun run build`, and the repository verification gate pass with an empty baseline failure list.
