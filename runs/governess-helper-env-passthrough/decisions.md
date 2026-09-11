# Decisions

## Explicit production policy

Keep a literal 35-name passthrough list beside `governessEnv()`. Keep raw
`LOOP_AU_PAIR_API_KEY` and `LOOP_UTILITY_API_KEY` names in a separate denylist.
Pass `*_API_KEY_FILE` paths because charter explicitly permits them.

## Derived coverage

Recursively scan TypeScript source with the charter regex, compare the result
with passthrough plus denylist, then feed values for every discovered name into
`governessEnv()` and assert only passthrough names emerge. This binds source
coverage to production wiring and makes removal mutation fail.

## Verification isolation

Do not modify user Usage Tracker cache or unrelated pricing test. Use a macOS
sandbox profile that denies reads of only that cache file for full CI. Record
plain-command failure and isolated-command pass separately.

