# Au Pair new-file authoring

## Problem

An Au Pair edit routed in run 120 declared two exact write files that did not yet exist. The helper searched one declared destination, the broker returned `not_found`, and the helper exhausted three rejected rounds without proposing a patch.

## Required behavior

- An absent path that exactly matches a declared write file is identified to the helper as a new-file target.
- Searching that exact target is a bounded empty search, not a broker rejection.
- Other absent, misspelled, undeclared, or merely parent-scoped paths remain fail-closed.
- The helper may only propose a patch artifact; it must not write the workspace.
