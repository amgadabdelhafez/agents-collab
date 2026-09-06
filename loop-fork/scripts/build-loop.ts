import { dirname, join } from "node:path";
import { type BunPlugin, build, file } from "bun";
import { prepareTemporalWorkerForCompiledBundle } from "./temporal-worker-compile";

const TEMPORAL_BUNDLER_PATH_RE =
  /@temporalio\/worker\/lib\/workflow\/bundler\.js$/;

const temporalPrebuiltBundlePlugin: BunPlugin = {
  name: "temporal-prebuilt-workflow-bundle",
  setup(build) {
    build.onLoad({ filter: TEMPORAL_BUNDLER_PATH_RE }, async ({ path }) => {
      const source = await file(path).text();
      const interceptorPath = join(
        dirname(dirname(path)),
        "workflow-log-interceptor.js"
      );
      const interceptorSource = await file(interceptorPath).text();
      return {
        contents: prepareTemporalWorkerForCompiledBundle(
          source,
          interceptorSource
        ),
        loader: "js",
      };
    });
  },
};

// LOOP_BUILD_TARGET (for example bun-linux-x64) and LOOP_BUILD_OUTFILE let the
// same script cross-compile the sandbox image binary; defaults are unchanged.
const compileTarget = process.env.LOOP_BUILD_TARGET;
const result = await build({
  compile: {
    outfile: process.env.LOOP_BUILD_OUTFILE ?? "loop",
    ...(compileTarget ? { target: compileTarget } : {}),
  },
  entrypoints: ["src/cli.ts"],
  external: ["loader-utils", "@swc/wasm"],
  plugins: [temporalPrebuiltBundlePlugin],
  target: "bun",
});

for (const log of result.logs) {
  console.error(log);
}
if (!result.success) {
  process.exitCode = 1;
}
