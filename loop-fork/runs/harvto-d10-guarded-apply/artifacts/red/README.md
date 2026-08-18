# D10 exact-base red evidence

Task: `harvto-d10-guarded-apply`

Regression: `D10 guarded apply rejects absent null-preimage target before mutation and journaling`

This immutable capture was produced from exact base `1282bd4c39ec7b3c0177810b30dab78ca6d66f41` on
`refs/heads/codex/harvto-supervisor-defects`, with an empty index and unchanged production. The approved test-only
diff creates one live-authority completed utility edit for absent exact target `src/new.ts`, using
a valid creation patch, broker-produced manifest, correct artifact hashes, and proposal preimage
`null`.

The command selected one test and filtered 57. It exited 1 because unchanged production returned
`applied`, created the target with SHA-256
`a568bdcc8ccc6cc56a201d8eee207a4ec38998aa78a0ad4edd66472ec50d7e41`, and appended exactly one `patch-applied` event. Event order,
authority epochs, artifact hashes, proposal target/preimage, application pre/postimages, and
post-call target state are recorded in `fixture.json` and the literal terminal output.

Capture start: `2026-08-18T08:45:08Z`
Capture end: `2026-08-18T08:45:09Z`
Command cwd: `/Users/amgad/dev_projects/agents-collab-harvto-supervisor-defects/loop-fork`
Terminal exit: `1`

Production SHA-256 values are recorded in `fixture.json`. `fixture.patch` is the exact test-only
worktree diff. No production, contract, prior evidence, Harness terminal state, utility route,
Harvto, D11, or D12 byte was changed. This red must never be recaptured after production editing.
`SHA256SUMS` covers the other five files and must validate 5/5.
