# Plan: Nanny Generation Readiness

1. Reproduce the live distinction between model-catalog health and generation.
2. Verify the MLX/Qwen chat-template control independently with a raw request.
3. Configure Pi's Nanny model as reasoning-capable while forcing the Nanny
   session thinking level off.
4. Bound the registered Nanny output budget to 3,200 tokens.
5. Add request-body regression coverage for Nanny and a non-regression check
   for Au Pair.
6. Run focused tests, the supported full suite, check, build, and diff checks.
7. Commit and request exact-SHA supervisor review; do not deploy.
