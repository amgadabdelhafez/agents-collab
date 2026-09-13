# Mutation proof

## Gateway header dropped

Mutation renamed `x-switchyard-intake-task` on the loopback model. Certified focused test
failed as required:

```text
Expected: "utility-task-123"
Received: undefined
4 pass, 2 fail
```

## Header leaked to direct OpenRouter

Mutation added `x-switchyard-intake-task` to the direct catalog-model override. Certified
focused test failed as required:

```text
Received: "must-not-reach-openrouter"
5 pass, 1 fail
```

Both mutations were reverted. Final certified focused test passed 6 tests with 0 failures
and 24 expectations.
