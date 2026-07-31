# Verify: Cross-Component Fixture Provenance

## Functional checks

| # | Check | Pass condition |
|---|---|---|
| F-01 | Captured-fixture rule | Names producer, version, capture command/time, raw bytes or SHA/reference, deterministic normalization |
| F-02 | Synthetic boundary | Synthetic fixtures are labeled and cannot certify integration seams |
| F-03 | Safety | Rule requires secret/PII sanitization before commit |
| F-04 | Template enforcement | Reusable verification checklist contains the same requirements |
| F-05 | Scope | Only planned docs, Harness evidence, and task specs change |

## UI checks

Not applicable; documentation-only task.

## Regression guards

- [ ] Existing eval commands and directory structure remain unchanged.
- [ ] No raw incident capture is fabricated or committed.
