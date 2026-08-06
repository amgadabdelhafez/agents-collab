# World Model committed large-blob reads

## Problem

The first production launch with default-on World Model activation failed while
reading a tracked 2,484,371-byte JSON fixture from an exact commit. The same
`git show <sha>:<path>` succeeds independently. The World Model uses Node's
synchronous child-process API without overriding its 1 MiB output ceiling, so
a legitimate committed blob is rejected before the paired loop can launch.

## Requirements

- Read every selected committed blob completely from the exact launch commit.
- Bound each blob read from Git's own immutable object size, not from an
  arbitrary hand-tuned constant.
- Fail closed if Git cannot report a valid non-negative object size, cannot
  return the blob, or returns a byte count different from the declared size.
- Preserve exact blob bytes for evidence hashing and extraction.
- Add a producer-backed launch-path regression with a real committed blob of
  exactly 2,484,371 bytes, greater than Node's default synchronous buffer.
- Preserve cleanup and absent-manifest behavior when activation fails.

## Out of scope

- Skipping large tracked files.
- Retrofitting or launching loop 138.
- Changing World Model ontology, authority, selection, or context limits.
- Deploying or merging the candidate.
