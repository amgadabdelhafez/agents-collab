# Plan: Claude Startup Readiness Timeout Preservation

1. Introduce a narrow typed input-required startup error shared by the
   existing composer-recovery failures and the readiness-timeout failure.
2. Attach stable paired pane targets to that error at the layout boundary.
3. Route the typed timeout through the existing preservation branch, while
   retaining fatal teardown for unrelated errors.
4. Update deterministic tmux lifecycle coverage to assert nonzero failure,
   durable recovery targets, released local ownership, and no teardown/paste.
5. Update the realistic-prompt smoke to inspect the preserved session and
   manifest before explicitly cleaning up the fixture.
6. Run focused tests, the full verifier, an isolated live timeout smoke, and an
   independent exact-commit review before considering deployment.
