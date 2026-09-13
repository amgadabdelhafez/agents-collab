# Verification

- Gateway-path Au Pair request carries `x-switchyard-intake-task` with the owning Loop run ID.
- Direct OpenRouter model/request carries no `x-switchyard-intake-task`.
- Dropping the gateway header fails its test.
- Adding the header to direct OpenRouter fails its test.
- `LOOP_TEST_CERTIFICATION_MODE=single-file bun test tests/loop/pi-runtime.test.ts`
  passes.
- Every other touched test file passes under single-file certification.
- `bun run check` passes.
- `bun run test:ci` reports zero failures across 116 files.
