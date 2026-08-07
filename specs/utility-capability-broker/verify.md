# Verify: Utility Capability Broker

```bash
cd loop-fork
bun run test:file -- tests/loop/utility-tools.test.ts
bun run test:file -- tests/loop/utility-context.test.ts
bun run test:file -- tests/loop/utility-runtime.test.ts
bun run test:file -- tests/loop/utility-pi-harness.test.ts
bun run test:ci
bun run check
bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts
bun run build
git diff --check
scripts/verify.sh utility-capability-broker utility-capability-broker
```

Security probes must cover:

- protected, out-of-scope, absent, symlinked, duplicate, directory, binary,
  malformed, oversized, and output-overflow inputs;
- JSON Pointer root, escaped tokens, missing values, malformed pointers, and
  forbidden prototype-like tokens;
- an exact loop-140 review shape hashing multiple declared files without any
  command invocation;
- capability-map determinism, capsule-hash binding, exact tool exposure, and
  effective repository-policy command prefixes;
- command-denial feedback that names `inspect_files`, `read_json`, Git tools,
  and the effective safe command prefixes without exposing secrets.

Release remains gated on exact-SHA supervisor review and a separately
authorized build/install/live canary.
