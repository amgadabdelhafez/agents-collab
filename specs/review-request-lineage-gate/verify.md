# Verification

- A descendant containing all three protections emits the body plus a full-SHA stamp.
- A sibling commit exits nonzero with empty stdout.
- A descendant missing any protection exits nonzero with empty stdout.
- The real candidate passes against cleared tip `8fb000ff`.
