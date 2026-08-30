import { type BunPlugin, build, file } from "bun";

const interceptorMarker =
  "exports.defaultWorkflowInterceptorModules = [require.resolve('../workflow-log-interceptor')];";
const TEMPORAL_BUNDLER_PATH_RE =
  /@temporalio\/worker\/lib\/workflow\/bundler\.js$/;

const temporalPrebuiltBundlePlugin: BunPlugin = {
  name: "temporal-prebuilt-workflow-bundle",
  setup(build) {
    build.onLoad({ filter: TEMPORAL_BUNDLER_PATH_RE }, async ({ path }) => {
      const source = await file(path).text();
      const occurrences = source.split(interceptorMarker).length - 1;
      if (occurrences !== 1) {
        throw new Error(
          `Temporal worker interceptor marker count is ${occurrences}; refusing an unverified compile transform`
        );
      }
      return {
        contents: source.replace(
          interceptorMarker,
          "exports.defaultWorkflowInterceptorModules = [];"
        ),
        loader: "js",
      };
    });
  },
};

const result = await build({
  compile: { outfile: "loop" },
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
