# Verify: Nanny Generation Readiness

- [x] A Pi Nanny completion sends
      `chat_template_kwargs.enable_thinking=false`.
- [x] The same request preserves `preserve_thinking=true` for multi-turn tool
      compatibility.
- [x] The registered Nanny model is reasoning-capable and has `maxTokens=3200`.
- [x] Au Pair does not receive Nanny's Qwen chat-template controls.
- [x] Existing Nanny tool-turn coverage still passes.
- [x] `bun run test:file -- tests/loop/pi-runtime.test.ts` passes.
- [x] `npm run test:ci` passes with no tolerated failure-name swaps.
- [x] `bun run check`, `bun run build`, and `git diff --check` pass.
- [x] The verified candidate is ready for an exact-SHA review request.
- [ ] Independent exact-SHA review is obtained before deployment.
