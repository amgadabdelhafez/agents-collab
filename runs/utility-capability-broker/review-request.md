Purpose: Review the utility capability broker candidate that fixes the loop-140 Au Pair capability-contract failure.

Claim under review:

- Add broker-native `inspect_files` for bounded SHA-256, byte, newline, and text/binary metadata without command execution or file-content disclosure.
- Add broker-native `read_json` for bounded RFC 6901 JSON Pointer selection without undeclared sibling disclosure.
- Persist the exact effective broker capability map in each utility context capsule and bind it into the capsule hash.
- Guide workers toward exposed semantic tools and append safe alternatives to every command-denied response, instead of encouraging executable probing.
- Preserve exact read/write scope, protected-path, regular-file, symlink, input-size, output-size, tool-profile, and scrubbed-environment boundaries.

Producer-backed regression evidence:

- A loop-140-shaped two-file review fixture independently derives both SHA-256 values with zero spawned commands and zero content disclosure.
- A manifest fixture returns only the three declared JSON Pointer outcomes and does not expose an undeclared sibling.
- Focused suites: 119 passed, 0 failed.
- Governed `scripts/verify.sh utility-capability-broker utility-capability-broker`: lint, typecheck, compiled build, every sorted test file, and empty named baseline allowlist all passed after the final metadata correction.
- `runs/utility-capability-broker/eval.json`: verdict `pass`, `baseline_failures: []`.

Known limitation: automatic shell-command classification is unchanged. The new tools are exposed to admitted unprofiled inspection and utility-audit jobs; exact execution profiles remain single-tool.

Requested action: Review the exact candidate SHA in the attached gate stamp. CONCUR only if the capability contract is materially richer while the broker remains the sole authority boundary. This request does not authorize merge, push, installation, or deployment.
