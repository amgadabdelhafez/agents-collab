# Verification

```bash
cd loop-fork
bun test tests/loop/utility-execution-tier.test.ts
bun test tests/loop/pi-runtime.test.ts tests/loop/utility-pi-harness.test.ts
bun test tests/loop/utility-runtime.test.ts tests/loop/utility-tools.test.ts
bun test tests/loop/governess-llm.test.ts
bun test
bun run build
git diff --check
cd ..
scripts/verify.sh
```

Additional gates:

- Assert exact read/check fixtures complete with `modelCalls: 0`.
- Assert new-loop pane creation and titles distinguish Nanny from Au Pair.
- Run fake streaming providers for local and OpenRouter model configurations.
- Assert the Pi session exposes only current broker tools and no built-ins.
- Run a no-tools completion against local MLX and one harmless brokered tool
  call without modifying Loop 55.
- Run a fake-provider fixture through the compiled `loop` binary.
- Capture Loop 55 pane IDs/PIDs before and after and prove they are unchanged.
- Record Pi version, commands, compatibility results, live-canary evidence, and
  an independent evaluator verdict in `runs/pi-sdk-utility-harness/`.
