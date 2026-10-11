import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  coreBridgeTargetFor,
  embedCoreBridgeNativeAddon,
  embedSourceMapWasm,
  prepareTemporalWorkerForCompiledBundle,
  TEMPORAL_NOOP_INTERCEPTOR_SHA256,
} from "../../scripts/temporal-worker-compile";

const workerRoot = join(
  import.meta.dir,
  "../../node_modules/@temporalio/worker"
);
const bundlerSource = readFileSync(
  join(workerRoot, "lib/workflow/bundler.js"),
  "utf8"
);
const interceptorSource = readFileSync(
  join(workerRoot, "lib/workflow-log-interceptor.js"),
  "utf8"
);

test("compiled Temporal worker removes only the exact pinned deprecated no-op interceptor", () => {
  expect(TEMPORAL_NOOP_INTERCEPTOR_SHA256).toBe(
    "aa03c7d6f9573d1021e2c6678f3d466233ba58af2f3d5731d01f5c50da89bc81"
  );
  const transformed = prepareTemporalWorkerForCompiledBundle(
    bundlerSource,
    interceptorSource
  );
  expect(transformed).not.toContain(
    "require.resolve('../workflow-log-interceptor')"
  );
  expect(transformed).toContain(
    "exports.defaultWorkflowInterceptorModules = [];"
  );
});

test("compiled Temporal worker refuses changed interceptor or bundler bytes", () => {
  expect(() =>
    prepareTemporalWorkerForCompiledBundle(
      bundlerSource,
      `${interceptorSource}\nchanged`
    )
  ).toThrow("is not the reviewed no-op");
  expect(() =>
    prepareTemporalWorkerForCompiledBundle(
      bundlerSource.replace(
        "require.resolve('../workflow-log-interceptor')",
        "require.resolve('../different-interceptor')"
      ),
      interceptorSource
    )
  ).toThrow("marker count is 0");
});

// 2026-10-11: the compiled binary loaded the Temporal core bridge from the
// BUILD worktree's node_modules (`__dirname` is baked in at compile time and
// index.js computes the path at run time), so the installed binary depended
// on a checkout that can move or vanish. The compile now requires the
// target's prebuilt `index.node` by a literal path, which Bun embeds.
const bridgeIndex = readFileSync(
  join(import.meta.dir, "../../node_modules/@temporalio/core-bridge/index.js"),
  "utf8"
);

test("the compiled core bridge requires its prebuilt addon by a literal path, which Bun embeds", () => {
  const transformed = embedCoreBridgeNativeAddon(
    bridgeIndex,
    "aarch64-apple-darwin"
  );
  expect(transformed).toContain(
    `Object.entries(require("./releases/aarch64-apple-darwin/index.node"))`
  );
  expect(transformed).not.toContain("getPrebuiltPath()");
  expect(transformed).not.toContain("require(nativeLibPath)");
  expect(() =>
    embedCoreBridgeNativeAddon(
      bridgeIndex.replace("require(nativeLibPath)", "require(otherPath)"),
      "aarch64-apple-darwin"
    )
  ).toThrow("marker count is 0");
  expect(() => embedCoreBridgeNativeAddon(bridgeIndex, "../../evil")).toThrow(
    "not a core bridge prebuilt target"
  );
});

test("each build target maps to the core bridge prebuilt it ships with", () => {
  expect(coreBridgeTargetFor(undefined, "darwin", "arm64")).toBe(
    "aarch64-apple-darwin"
  );
  expect(coreBridgeTargetFor(undefined, "linux", "x64")).toBe(
    "x86_64-unknown-linux-gnu"
  );
  expect(coreBridgeTargetFor("bun-linux-x64", "darwin", "arm64")).toBe(
    "x86_64-unknown-linux-gnu"
  );
  expect(coreBridgeTargetFor("bun-linux-arm64", "darwin", "arm64")).toBe(
    "aarch64-unknown-linux-gnu"
  );
  expect(coreBridgeTargetFor("bun-darwin-x64-baseline", "linux", "x64")).toBe(
    "x86_64-apple-darwin"
  );
  expect(() =>
    coreBridgeTargetFor("bun-linux-x64-musl", "linux", "x64")
  ).toThrow("no Temporal core bridge prebuilt for bun-linux-x64-musl");
});

// The same build-tree dependency, found by running the built binary with the
// build's node_modules renamed: the worker's workflow sandbox reads
// source-map's mappings.wasm from `__dirname` at run time.
test("the compiled source-map reader returns the embedded mappings.wasm bytes, never reading the build tree", async () => {
  const sourceMapLib = join(
    import.meta.dir,
    "../../node_modules/source-map/lib"
  );
  const readerSource = readFileSync(join(sourceMapLib, "read-wasm.js"), "utf8");
  const wasm = readFileSync(join(sourceMapLib, "mappings.wasm"));
  const transformed = embedSourceMapWasm(readerSource, wasm);
  expect(transformed).not.toContain("__dirname");
  expect(transformed).not.toContain("readFile");
  const module = { exports: {} as Record<string, unknown> };
  new Function("module", "require", transformed)(module, () => {
    throw new Error("the embedded reader requires nothing");
  });
  const readWasm = module.exports as unknown as () => Promise<ArrayBuffer>;
  expect(Buffer.from(await readWasm()).equals(wasm)).toBe(true);
  expect(typeof (module.exports as { initialize?: unknown }).initialize).toBe(
    "function"
  );
  expect(() =>
    embedSourceMapWasm(readerSource.replace("__dirname", "elsewhere"), wasm)
  ).toThrow("marker count is 0");
});
