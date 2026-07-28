# Loop-59 recon runtime integration

## Problem

The active runtime branch contains the Pi helper, routing, Claude-config, and
Loop-58 corrections, but it diverged before the later recon-pane and Governess
layout work landed on `codex/loop57-runtime-fixes`. Fresh Loop-59 therefore
starts only Claude, Codex, Governess, Nanny, and Au Pair.

## Required outcome

- Integrate the recon/layout line through `015d35b` with the active runtime
  line through `117c7f8`, preserving both sets of behavior.
- Keep the semantic helper names Nanny and Au Pair; recon panes use their
  purpose-specific titles from the layout line.
- Rebuild and install the integrated binary.
- Add the missing recon panes to `harvto-loop-59` and hot-swap only supervisory
  panes. Do not restart Claude, Codex, or the active batch process.
- Verify focused tests, the full loop suite, build, live pane topology, stable
  main-agent PIDs, and continuing batch execution.

## Safety

- No remote push, merge to main, deployment, or Harvto source mutation.
- Preserve the active home bridge registration while Claude remains alive.
- Never kill or respawn the active Claude/Codex panes.
