# Verification

```bash
cd loop-fork
bun test tests/loop/world-model-runtime.test.ts tests/loop/world-model.test.ts
bun run check
bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts
bun run build
bun run test:ci
git diff --check
```

The producer-backed regression must create and commit a 2,484,371-byte blob,
materialize it through the default-on launch path, and prove the World Model
accepted the exact bytes. The mandatory suite must finish with an empty
failure set; missing or malformed Git object sizes must remain fail-closed.
