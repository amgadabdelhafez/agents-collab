# Plan

1. Reproduce the production boundary with a real temporary Git repository and
   a 2,484,371-byte committed fixture through `prepareRunWorldModel`.
2. Add an exact-object-size committed-blob reader using `git cat-file -s` to
   derive the `git show` output bound.
3. Verify the returned byte count matches the immutable object size before the
   bytes are accepted for hashing or extraction.
4. Run focused World Model tests, static checks, typecheck, build, and the
   mandatory complete suite with an empty failure set.
5. Commit the exact candidate and request supervisor review over xchan.
