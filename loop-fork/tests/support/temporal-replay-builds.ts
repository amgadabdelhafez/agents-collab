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

export const LOOP_FORK_ROOT = join(import.meta.dir, "../..");

export interface ReplaySource {
  /** Short name the fixtures and test names use. */
  label: string;
  /** The message workflow id format that build mints for a new message. */
  messageIdFormat: "deployment" | "legacy";
  ref: string;
  summary: string;
}

/** The earlier lines whose in-flight executions a current host inherits. */
export const REPLAY_SOURCES: readonly ReplaySource[] = [
  {
    label: "r2-40097564",
    messageIdFormat: "legacy",
    ref: "4009756459cb5db81f69d714206ae6be1bc1b193",
    summary:
      "r2: last line before the keyed result graph id and the deployment discriminator",
  },
  {
    label: "r3-ef570282",
    messageIdFormat: "deployment",
    ref: "ef5702821d0a233cdb3ce99e7949929587720613",
    summary: "r3: deployment-format workflow ids and keyed result graph ids",
  },
];

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

const bundleModulesOf = (code: string): Map<string, string> => {
  const stripped = bundleCodeOf(code);
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
  /** That commit's `loop-fork`, with this checkout's node_modules linked. */
  root: string;
  source: ReplaySource;
}

const run = (
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

/**
 * Extract one commit's `loop-fork/src`. Fails, never skips, when the commit
 * is not in this clone (a shallow clone cannot run the live handoff test).
 */
export const extractBuild = async (
  source: ReplaySource
): Promise<ExtractedBuild> => {
  const top = String(run("git", ["rev-parse", "--show-toplevel"])).trim();
  const archive = run(
    "git",
    [
      "archive",
      "--format=tar",
      source.ref,
      "loop-fork/src",
      "loop-fork/package.json",
    ],
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
    // The dependency lock is unchanged since both sources (bun.lock and
    // package.json diff empty), so this checkout's modules are theirs.
    symlinkSync(
      join(LOOP_FORK_ROOT, "node_modules"),
      join(root, "node_modules")
    );
    const generated = (await import(
      join(root, "src/loop/temporal-workflow-bundle.generated.ts")
    )) as { temporalWorkflowBundleBase64: string };
    return {
      bundleCode: decodeBundle(generated.temporalWorkflowBundleBase64),
      close: () => rmSync(directory, { force: true, recursive: true }),
      root,
      source,
    };
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
};
