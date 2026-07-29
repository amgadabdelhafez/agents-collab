# Large prompt launch reliability

## Problem

The deployed `loop` binary at commit `c78b35d` silently exits successfully
without creating a paired tmux workspace when `--prompt-file` content reaches
roughly 2.9 KB. Real loop charters exceed 8 KB, so the launcher is unusable for
production work while tiny lifecycle smoke prompts continue to pass.

## Requirements

1. `loop --tmux --agent codex --pair-with claude -p <file>` must launch with a
   prompt of at least 10,257 bytes.
2. Prompt content must not be embedded in a tmux command, shell argument, or
   another transport with a small command-size ceiling.
3. A launch that does not create or hand off to the requested workspace must
   return a nonzero exit code and a useful error.
4. Automated coverage must exercise a realistic prompt of at least 8 KB.
5. Existing promptless and small-prompt launch behavior must remain unchanged.

## Scope

- Paired tmux startup and its tests.
- Lifecycle smoke coverage for realistic prompt size.
- No routing, pane-layout, model, or governess-policy changes.
