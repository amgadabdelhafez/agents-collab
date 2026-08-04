# Exact structured-plan arguments

## Problem

Loop 122 routed an Au Pair audit with two persisted exact file ranges. GLM selected the correct `read_file` tool but drifted from the exact range, so the broker rejected three rounds and discarded the job.

## Requirement

- The immutable structured plan, not model-generated arguments, controls each broker call.
- The model must still select the tool required by the current step.
- A wrong tool name remains rejected.
- Broker path, command, range, and stage-order controls remain unchanged.

## Acceptance

- A fake GLM emits wrong paths and ranges for every read-plan step.
- The job completes all persisted reads and records four successful broker calls despite the model-supplied paths being outside scope.
- Focused tests, full certified tests, lint, build, and diff checks pass.
