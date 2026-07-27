# Plan: Governess summary completeness and retry

## Approach

Add one pure structural validator in the local-LLM boundary. Return an empty
result for invalid output so the board preserves its previous summary. Make
summary scheduling select the normal interval for valid text and a short retry
interval for invalid text, using the existing persisted `summaryTick` as the
attempt timestamp.

## Sequence

1. Add tests for complete, missing-section, and truncated-Next responses.
2. Add the validator and reject incomplete local-model output.
3. Add short invalid-summary retry scheduling and tests.
4. Run focused/full verification and build.
5. Restart only the live Governess pane with the new binary and verify a valid
   summary plus advancing state.

## Risks

- A useful terse Next sentence could be rejected; accept terminal punctuation
  even when the section is short.
- Repeated model failure could create a hot retry loop; use a named multi-tick
  backoff.
- Live deployment could disturb main agents; target only the Governess pane.

