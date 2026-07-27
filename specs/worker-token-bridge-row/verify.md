# Verification

- This historical slice verified `maxTokens=2400` and `maxTotalTokens=16000`;
  current defaults are covered by `specs/worker-unbounded-cost/verify.md`.
- Governess displays `bridge worker msgs` with in/out/pending and latest ages.
- The new row and every governess line fit the 176-column live pane.
- Focused tests and build pass; full-suite results are compared with baseline.
- Loop 47 keeps Claude and Codex pane PIDs unchanged after lower-pane refresh.
