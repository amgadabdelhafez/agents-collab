/**
 * Earlier builds' Temporal workflow bundles, taken from git: the workflow
 * bundle a host at that commit runs is the committed
 * `src/loop/temporal-workflow-bundle.generated.ts` (loop-orchestration-server
 * passes it as `workflowBundle`), so that file is what "the old bundle" means
 * here. The commit's `loop-fork/src` is extracted with `git archive` so its
 * own workflow port and contract can drive and name executions.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { temporalWorkflowBundleBase64 } from "../../src/loop/temporal-workflow-bundle.generated";
import {
  type DeployedReplayIdentity,
  deployedReplayScenarios,
  type ReplayFamily,
  type ReplayScenario,
  replayIdentityOf,
  replayScenarios,
} from "./temporal-replay-scenarios";

export const LOOP_FORK_ROOT = join(import.meta.dir, "../..");

export interface ReplaySource {
  /** Which workflow types the build registers (temporal-replay-scenarios). */
  family: ReplayFamily;
  /** Short name the fixtures and test names use. */
  label: string;
  /**
   * The commit the live handoff tests extract, when it is not `ref`: `ref`
   * is on no remote, and this commit, which a clone of this line holds,
   * commits the same blobs for every file the handoff runs (the generated
   * bundle and the workflow port). The recorder checks that, and the live
   * test checks the bundle against the digest recorded from `ref`.
   */
  liveRef?: string;
  /** The message workflow id format that build mints for a new message. */
  messageIdFormat: "deployment" | "legacy";
  /** The commit the fixtures were recorded from. */
  ref: string;
  summary: string;
}

/** The earlier lines whose in-flight executions a current host inherits. */
export const REPLAY_SOURCES: readonly ReplaySource[] = [
  {
    family: "v2-line",
    label: "r2-40097564",
    messageIdFormat: "legacy",
    ref: "4009756459cb5db81f69d714206ae6be1bc1b193",
    summary:
      "r2: last line before the keyed result graph id and the deployment discriminator",
  },
  {
    family: "v2-line",
    label: "r3-ef570282",
    messageIdFormat: "deployment",
    ref: "ef5702821d0a233cdb3ce99e7949929587720613",
    summary: "r3: deployment-format workflow ids and keyed result graph ids",
  },
  {
    family: "v2-line",
    label: "r4-00094c66",
    // Legacy write is r4's default; deployment ids only after an explicit flip.
    messageIdFormat: "legacy",
    ref: "00094c661fe6c1923737318d5e39d885d993b11c",
    summary:
      "r4: the workflow id format marker, legacy write by default (integration merge of fix4)",
  },
  {
    family: "v2-line",
    label: "r5base-c7646ed3",
    messageIdFormat: "legacy",
    ref: "c7646ed353ae2b2d7df0da17bd3d7c486a9209d5",
    summary: "round-5 base: recovery quarantine, legacy write by default",
  },
  {
    family: "deployed",
    label: "deployed-455ccc32",
    liveRef: "4439b2e7ec8d6cfde86c44af3f9818329639c359",
    // No V2 code: V1 message ids only, which have one format.
    messageIdFormat: "legacy",
    ref: "455ccc32e91af32e4bda69c3f6802ce84c4fdf5f",
    summary:
      "the live orchestration service's build (loop-ed33f43f): V1 messages, governess beat, task graphs",
  },
];

/** The files the live handoff runs from a source: what `liveRef` must share. */
export const LIVE_HANDOFF_FILES = [
  "loop-fork/src/loop/temporal-workflow-bundle.generated.ts",
  "loop-fork/src/loop/temporal-workflow-port.ts",
] as const;

/** The commit a live handoff extracts for a source. */
export const liveRefOf = (source: ReplaySource): string =>
  source.liveRef ?? source.ref;

/**
 * supervisor-message-coordinator.ts `workflowIdFor`, the only V1 message id
 * (unchanged from 455ccc32 to this line; private there, so restated here).
 */
export const v1MessageWorkflowId = (dedupeKey: string): string =>
  `supervisor-message:${createHash("sha256").update(dedupeKey).digest("hex")}`;

export const deployedReplayIdentity = (
  label: string
): DeployedReplayIdentity => ({ label, v1MessageWorkflowId });

/** What a `v2-line` build's supervisor-message-v2-contract module exports. */
export type ReplayContractModule = Parameters<typeof replayIdentityOf>[0];

/**
 * The scenarios a build of `family` runs, named as that build names them:
 * a `v2-line` build by its own contract module, a `deployed` build by the V1
 * coordinator's derivation.
 */
export const replayScenariosFor = (input: {
  contract?: ReplayContractModule;
  deployment: string;
  family: ReplayFamily;
  label: string;
  messageIdFormat: "deployment" | "legacy";
}): ReplayScenario[] => {
  if (input.family === "deployed") {
    return deployedReplayScenarios(deployedReplayIdentity(input.label));
  }
  if (!input.contract) {
    throw new Error(`a v2-line build needs its contract (${input.label})`);
  }
  return replayScenarios(
    replayIdentityOf(
      input.contract,
      input.label,
      input.messageIdFormat,
      input.deployment
    )
  );
};

export const decodeBundle = (base64: string): string =>
  Buffer.from(base64, "base64").toString("utf8");

const SOURCE_MAP_COMMENT = /\n\/\/# sourceMappingURL=[^\n]*\s*$/;

/** Bundle code without its inline source map, whose file name is random. */
export const bundleCodeOf = (code: string): string =>
  code.replace(SOURCE_MAP_COMMENT, "");

const MODULE_HEADER = /\n\/\*\*\*\/ "([^"\n]+)"\n/g;

/**
 * The modules of a webpack bundle by id. The bundler's module order is not
 * stable across checkouts (one module can move), so two bundles are compared
 * module by module, plus the code outside any module.
 */
const MODULE_TABLE_END =
  "\n/******/ \t});\n/************************************************************************/";
const MODULE_TAIL = /\n\/\*\*\*\/ \},?\s*$/;

/** `../../elsewhere/loop-fork/node_modules/` as a module id prefix. */
const OUTSIDE_NODE_MODULES = /(?:\.\.\/)+[^"\s*]*?\/node_modules\//g;
/** The `/*! id *\/` banner webpack writes around each module, sized to its id. */
const MODULE_BANNER = /^(?:\/\*!\*+!\*\\| +\\\*+\/)\n/gm;
/** A stub for a module the bundler ignores, named by a hash of its path. */
const IGNORED_MODULE_ID = /"\?[0-9a-f]{4}"/g;

/**
 * Bundle code with what only the build machine's paths decide taken out. A
 * bundle built where node_modules sat outside the checkout (the 455ccc32
 * committed bundle names `../../governess-helper-env/loop-fork/node_modules/`)
 * names every dependency module by that path, sizes each banner to it, and
 * hashes it into the ignored stubs' ids; none of it is code.
 */
const pathNeutral = (code: string): string =>
  code
    .replace(OUTSIDE_NODE_MODULES, "./node_modules/")
    .replace(MODULE_BANNER, "")
    .replace(IGNORED_MODULE_ID, '"?<ignored>"');

const bundleModulesOf = (code: string): Map<string, string> => {
  const stripped = pathNeutral(bundleCodeOf(code));
  const tableEnd = stripped.indexOf(MODULE_TABLE_END);
  const table = tableEnd < 0 ? stripped : stripped.slice(0, tableEnd);
  const headers = [...table.matchAll(MODULE_HEADER)];
  const modules = new Map<string, string>([
    ["<bundle prelude>", table.slice(0, headers[0]?.index)],
    ["<webpack runtime>", tableEnd < 0 ? "" : stripped.slice(tableEnd)],
  ]);
  headers.forEach((header, index) => {
    const start = (header.index ?? 0) + header[0].length;
    const end = headers[index + 1]?.index ?? table.length;
    modules.set(
      header[1] ?? "",
      table.slice(start, end).replace(MODULE_TAIL, "")
    );
  });
  return modules;
};

/** Module ids whose code differs between two bundles (empty: same code). */
export const differingBundleModules = (
  left: string,
  right: string
): string[] => {
  const a = bundleModulesOf(left);
  const b = bundleModulesOf(right);
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((id) => a.get(id) !== b.get(id))
    .sort();
};

export const bundleDigest = (code: string): string =>
  createHash("sha256").update(bundleCodeOf(code)).digest("hex");

/** The workflow bundle this checkout ships. */
export const currentBundleCode = (): string =>
  decodeBundle(temporalWorkflowBundleBase64);

export interface ExtractedBuild {
  /** The committed generated bundle at that commit, decoded. */
  bundleCode: string;
  close(): void;
  /** That commit's contract module; a `deployed` build has none. */
  contract?: ReplayContractModule;
  /** The commit extracted. */
  ref: string;
  /** That commit's `loop-fork`, with this checkout's node_modules linked. */
  root: string;
  source: ReplaySource;
}

export const run = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; input?: Buffer } = {}
): Buffer => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? LOOP_FORK_ROOT,
    input: options.input,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${String(
        result.stderr
      ).trim()}`
    );
  }
  return result.stdout;
};

/** The repository top level, where `git archive` paths are rooted. */
export const repositoryTop = (): string =>
  String(run("git", ["rev-parse", "--show-toplevel"])).trim();

/**
 * Extract one commit's `loop-fork/src` (by default the commit the live
 * handoff runs for `source`). Fails, never skips, when the commit is not in
 * this clone (a shallow clone cannot run the live handoff test).
 */
export const extractBuild = async (
  source: ReplaySource,
  ref: string = liveRefOf(source)
): Promise<ExtractedBuild> => {
  const top = repositoryTop();
  const archive = run(
    "git",
    ["archive", "--format=tar", ref, "loop-fork/src", "loop-fork/package.json"],
    { cwd: top }
  );
  // The real path: the bundler names modules relative to the working
  // directory, which the OS reports resolved (/private/var on macOS).
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), `replay-${source.label}-`))
  );
  try {
    run("tar", ["-x", "-C", directory], { input: archive });
    const root = join(directory, "loop-fork");
    // Every source's dependencies are this checkout's or a subset of them
    // (bun.lock and package.json: no diff from the V2 sources; 455ccc32
    // and 4439b2e7 lack only the two A2A packages added since), so this
    // checkout's modules serve them.
    symlinkSync(
      join(LOOP_FORK_ROOT, "node_modules"),
      join(root, "node_modules")
    );
    const generated = (await import(
      join(root, "src/loop/temporal-workflow-bundle.generated.ts")
    )) as { temporalWorkflowBundleBase64: string };
    const contract =
      source.family === "v2-line"
        ? ((await import(
            join(root, "src/loop/supervisor-message-v2-contract.ts")
          )) as ReplayContractModule)
        : undefined;
    return {
      bundleCode: decodeBundle(generated.temporalWorkflowBundleBase64),
      close: () => rmSync(directory, { force: true, recursive: true }),
      ...(contract ? { contract } : {}),
      ref,
      root,
      source,
    };
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
};
