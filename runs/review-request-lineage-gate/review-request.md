Purpose: Review the structural review-request lineage gate and the two wanted fixes restacked onto the cleared 8fb000ff lineage.

Changes:
- Add a fail-closed review-request emitter that refuses stale lineage or missing deployed protection symbols and emits a deterministic evidence stamp only after every check passes.
- Ignore narrative effort words outside explicit effort fields in Governess event parsing.
- Reject bridge sends to known agents absent from the run topology before writing durable bridge state.

Verification:
- Review-request gate producer tests: 3 pass, 0 fail, including empty-stdout negative lineage and missing-symbol cases.
- Governess focused suite: 73 pass, 0 fail.
- Bridge focused suite: 97 pass, 0 fail.
- Full verifier: lint, typecheck, compiled build, every sorted test file, and empty named baseline allowlist passed.

Requested action: Review the exact candidate SHA below. CONCUR only if the cleared-lineage binding, fail-closed emitter, and both restacked fixes are correct.
