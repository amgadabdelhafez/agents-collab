# Review-request lineage gate

## Problem

Three harness fixes were prepared from `origin/main` after the deployed protection chain had moved ahead on reviewed release branches. Static tests passed while the candidate silently omitted already-deployed safety mechanisms.

## Requirement

Review-request text must not be emitted unless the candidate descends from an explicitly supplied cleared tip and contains every named deployed protection. The passing output must include the exact candidate, required tip, lineage verdict, and symbol counts so the supervisor can verify the request without trusting prose.

`origin/main` is retired as a harness-fix base until it contains the cleared release lineage. New harness fixes must start from the cleared tip and pass this gate.
