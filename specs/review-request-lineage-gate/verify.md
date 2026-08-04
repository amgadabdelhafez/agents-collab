# Verification

- A descendant containing all three protections emits the body plus a full-SHA stamp.
- A sibling commit exits nonzero with empty stdout.
- A descendant missing any protection exits nonzero with empty stdout.
- The governed sender calls the durable channel exactly once with the stamped body after a pass.
- A gate failure makes zero durable-channel calls.
- The real candidate passes against cleared tip `d63ce10258a27e30946a4b92f7419870b8bb56bd`.
