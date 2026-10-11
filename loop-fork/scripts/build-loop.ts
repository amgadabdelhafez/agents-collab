import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { type BunPlugin, build, file } from "bun";
import { loopCodesignArguments } from "./loop-codesign";
import {
  coreBridgeTargetFor,
  embedCoreBridgeNativeAddon,
  embedSourceMapWasm,
  prepareTemporalWorkerForCompiledBundle,
} from "./temporal-worker-compile";

const TEMPORAL_BUNDLER_PATH_RE =
  /@temporalio\/worker\/lib\/workflow\/bundler\.js$/;
const TEMPORAL_CORE_BRIDGE_INDEX_RE = /@temporalio\/core-bridge\/index\.js$/;
const BUN_TARGET_PLATFORM_RE = /^bun-(darwin|linux|windows)-/;

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
const outfile = process.env.LOOP_BUILD_OUTFILE ?? "loop";

// The Temporal core bridge's native addon, embedded in the executable for
// the compile target instead of loaded from this build tree's node_modules.
const coreBridgeTarget = coreBridgeTargetFor(compileTarget);
const temporalEmbeddedCoreBridgePlugin: BunPlugin = {
  name: "temporal-embedded-core-bridge",
  setup(build) {
    build.onLoad(
      { filter: TEMPORAL_CORE_BRIDGE_INDEX_RE },
      async ({ path }) => ({
        contents: embedCoreBridgeNativeAddon(
          await file(path).text(),
          coreBridgeTarget
        ),
        loader: "js",
      })
    );
  },
};

// source-map's mappings.wasm (read by the worker's workflow sandbox),
// embedded likewise. Only the 0.7 reader reads it; 0.6 copies have none.
const SOURCE_MAP_READ_WASM_RE = /\/source-map\/lib\/read-wasm\.js$/;
const sourceMapWasmPlugin: BunPlugin = {
  name: "source-map-embedded-wasm",
  setup(build) {
    build.onLoad({ filter: SOURCE_MAP_READ_WASM_RE }, async ({ path }) => ({
      contents: embedSourceMapWasm(
        await file(path).text(),
        new Uint8Array(
          await file(join(dirname(path), "mappings.wasm")).arrayBuffer()
        )
      ),
      loader: "js",
    }));
  },
};

// Regenerate workflow definitions before compiling the service executable.
await import("./build-temporal-workflow-bundle");
const result = await build({
  compile: {
    outfile,
    ...(compileTarget ? { target: compileTarget } : {}),
  },
  entrypoints: ["src/cli.ts"],
  external: ["loader-utils", "@swc/wasm"],
  plugins: [
    temporalPrebuiltBundlePlugin,
    temporalEmbeddedCoreBridgePlugin,
    sourceMapWasmPlugin,
  ],
  target: "bun",
});

for (const log of result.logs) {
  console.error(log);
}
if (!result.success) {
  process.exitCode = 1;
} else if (process.platform === "darwin") {
  // A stable code signature for macOS (see scripts/loop-codesign.ts):
  // LOOP_CODESIGN_IDENTITY names an identity in the login keychain; unset,
  // the binary is signed ad hoc under the same identifier.
  const targetPlatform = compileTarget
    ? (BUN_TARGET_PLATFORM_RE.exec(compileTarget)?.[1] ?? "unknown")
    : process.platform;
  const args = loopCodesignArguments(
    outfile,
    process.env.LOOP_CODESIGN_IDENTITY,
    targetPlatform
  );
  if (args) {
    const signed = spawnSync("codesign", args, { stdio: "inherit" });
    if (signed.status !== 0) {
      console.error(`codesign failed for ${outfile}`);
      process.exitCode = 1;
    }
  }
}
