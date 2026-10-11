import { createHash } from "node:crypto";

const INTERCEPTOR_ASSIGNMENT =
  "exports.defaultWorkflowInterceptorModules = [require.resolve('../workflow-log-interceptor')];";
const EMPTY_INTERCEPTOR_ASSIGNMENT =
  "exports.defaultWorkflowInterceptorModules = [];";
export const TEMPORAL_NOOP_INTERCEPTOR_SHA256 =
  "aa03c7d6f9573d1021e2c6678f3d466233ba58af2f3d5731d01f5c50da89bc81";

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const prepareTemporalWorkerForCompiledBundle = (
  bundlerSource: string,
  interceptorSource: string
): string => {
  const interceptorSha256 = sha256(interceptorSource);
  if (interceptorSha256 !== TEMPORAL_NOOP_INTERCEPTOR_SHA256) {
    throw new Error(
      `Temporal workflow interceptor is not the reviewed no-op: ${interceptorSha256}`
    );
  }
  const occurrences = bundlerSource.split(INTERCEPTOR_ASSIGNMENT).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Temporal worker interceptor marker count is ${occurrences}; refusing an unverified compile transform`
    );
  }
  return bundlerSource.replace(
    INTERCEPTOR_ASSIGNMENT,
    EMPTY_INTERCEPTOR_ASSIGNMENT
  );
};

const SOURCE_MAP_WASM_MARKERS = [
  'const wasmPath = path.join(__dirname, "mappings.wasm");',
  "fs.readFile(wasmPath, null, (error, data) => {",
];

/**
 * source-map 0.7 (the Temporal worker's workflow sandbox maps stack traces
 * with it) reads `mappings.wasm` from `__dirname` at run time, which a
 * compiled binary bakes in as the BUILD tree's path. The compiled reader
 * returns the bytes embedded at build time instead. Refuses unexpected source.
 */
export const embedSourceMapWasm = (
  readWasmSource: string,
  wasm: Uint8Array
): string => {
  for (const marker of SOURCE_MAP_WASM_MARKERS) {
    const occurrences = readWasmSource.split(marker).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `source-map wasm reader marker count is ${occurrences}; refusing an unverified compile transform`
      );
    }
  }
  const base64 = Buffer.from(wasm).toString("base64");
  return `"use strict";
// Compiled by scripts/build-loop.ts: mappings.wasm embedded at build time.
const bytes = Buffer.from(${JSON.stringify(base64)}, "base64");
module.exports = function readWasm() {
  return Promise.resolve(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  );
};
module.exports.initialize = (_) => {
  console.debug(
    "SourceMapConsumer.initialize is a no-op when running in node.js"
  );
};
`;
};

/** The prebuilt targets @temporalio/core-bridge ships (releases/<target>). */
const CORE_BRIDGE_TARGETS = new Set([
  "aarch64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
]);
const CORE_BRIDGE_PATH_LINE = "  const nativeLibPath = getPrebuiltPath();\n";
const CORE_BRIDGE_REQUIRE = "require(nativeLibPath)";
const BUN_TARGET_RE =
  /^bun-(darwin|linux|windows)-(x64|arm64)(?:-(baseline|modern))?$/;
const PLATFORMS: Record<string, string> = {
  darwin: "apple-darwin",
  linux: "unknown-linux-gnu",
  win32: "pc-windows-msvc",
  windows: "pc-windows-msvc",
};
const ARCHES: Record<string, string> = { arm64: "aarch64", x64: "x86_64" };

/**
 * The core bridge prebuilt for a Bun compile target (LOOP_BUILD_TARGET, for
 * example bun-linux-x64) or, without one, for this host.
 */
export const coreBridgeTargetFor = (
  bunTarget: string | undefined,
  platform: string = process.platform,
  arch: string = process.arch
): string => {
  let os = platform;
  let cpu = arch;
  if (bunTarget !== undefined) {
    const match = BUN_TARGET_RE.exec(bunTarget);
    if (!match) {
      throw new Error(`no Temporal core bridge prebuilt for ${bunTarget}`);
    }
    os = match[1] as string;
    cpu = match[2] as string;
  }
  const target = `${ARCHES[cpu]}-${PLATFORMS[os]}`;
  if (!CORE_BRIDGE_TARGETS.has(target)) {
    throw new Error(
      `no Temporal core bridge prebuilt for ${bunTarget ?? `${platform}-${arch}`}`
    );
  }
  return target;
};

/**
 * @temporalio/core-bridge/index.js finds its native addon at run time from
 * `__dirname`, which a compiled binary bakes in as the BUILD tree's path:
 * the binary then loads the addon from that checkout's node_modules (and
 * fails when it moves). Requiring the target's prebuilt by a literal path
 * instead makes Bun embed it in the executable. Refuses unexpected source.
 */
export const embedCoreBridgeNativeAddon = (
  indexSource: string,
  target: string
): string => {
  if (!CORE_BRIDGE_TARGETS.has(target)) {
    throw new Error(`${target} is not a core bridge prebuilt target`);
  }
  for (const marker of [CORE_BRIDGE_PATH_LINE, CORE_BRIDGE_REQUIRE]) {
    const occurrences = indexSource.split(marker).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `Temporal core bridge marker count is ${occurrences}; refusing an unverified compile transform`
      );
    }
  }
  return indexSource
    .replace(CORE_BRIDGE_PATH_LINE, "")
    .replace(
      CORE_BRIDGE_REQUIRE,
      `require(${JSON.stringify(`./releases/${target}/index.node`)})`
    );
};
