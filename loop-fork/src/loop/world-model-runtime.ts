import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { PairedLaunchClaim } from "./launch-reservation";
import {
  type RunWorldModelBinding,
  touchRunManifest,
  updateRunManifest,
} from "./run-state";
import { materializeGitRepository, WorldModelStore } from "./world-model";

const WORLD_MODEL_DIR = "world-model";
const MAX_TASK_SEEDS = 12;
const MAX_CONTEXT_DEPTH = 2;
const MAX_CONTEXT_STATEMENTS = 120;
const ENTRY_DOCUMENTS = ["AGENTS.md", "CLAUDE.md", "PLAN.md", "README.md"];

const fileSha256 = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

const taskSeeds = (
  store: WorldModelStore,
  task: string | undefined
): string[] => {
  const normalizedTask = task?.toLowerCase() ?? "";
  if (normalizedTask) {
    const matches = store
      .entities()
      .filter((entity) => ["File", "Spec", "Test"].includes(entity.type))
      .map((entity) => entity.label)
      .filter((label) => normalizedTask.includes(label.toLowerCase()));
    const seeds = [...new Set(matches)].sort().slice(0, MAX_TASK_SEEDS);
    if (seeds.length > 0) {
      return seeds;
    }
  }

  const entities = store.entities();
  const fallback = ENTRY_DOCUMENTS.flatMap((label) =>
    entities
      .filter((entity) => entity.label === label)
      .map((entity) => entity.id)
  ).slice(0, MAX_TASK_SEEDS);
  if (fallback.length > 0) {
    return fallback;
  }
  const repository = entities.find((entity) => entity.type === "Repository");
  if (!repository) {
    throw new Error(
      "World Model projection does not contain a repository entity"
    );
  }
  return [repository.id];
};

export const prepareRunWorldModel = (
  claim: PairedLaunchClaim,
  task?: string
): RunWorldModelBinding => {
  const runDir = resolve(claim.storage.runDir);
  const directory = join(runDir, WORLD_MODEL_DIR);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  chmodSync(directory, 0o700);

  const nonce = `${process.pid}-${randomUUID()}`;
  const temporaryDatabasePath = join(directory, `.project-${nonce}.sqlite`);
  const temporaryContextPath = join(directory, `.bootstrap-${nonce}.json`);
  let store: WorldModelStore | undefined;
  try {
    store = new WorldModelStore(temporaryDatabasePath);
    const materialized = materializeGitRepository(
      store,
      claim.workspaceBinding.root
    );
    const seeds = taskSeeds(store, task);
    const context = store.context({
      maxDepth: MAX_CONTEXT_DEPTH,
      maxStatements: MAX_CONTEXT_STATEMENTS,
      seeds,
    });
    const contextContent = `${JSON.stringify(context, null, 2)}\n`;
    writeFileSync(temporaryContextPath, contextContent, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(temporaryContextPath, 0o600);
    store.close();
    store = undefined;

    const databasePath = join(
      directory,
      `project-${materialized.commitSha}.sqlite`
    );
    const contextPath = join(
      directory,
      `bootstrap-${context.capsuleSha256}.json`
    );
    renameSync(temporaryDatabasePath, databasePath);
    renameSync(temporaryContextPath, contextPath);
    chmodSync(databasePath, 0o600);
    chmodSync(contextPath, 0o600);

    const binding: RunWorldModelBinding = {
      capsuleSha256: context.capsuleSha256,
      commitSha: materialized.commitSha,
      contextPath,
      contextSha256: fileSha256(contextContent),
      databasePath,
      entityCount: materialized.entityCount,
      generatedAt: new Date().toISOString(),
      ontologyVersion: materialized.ontologyVersion,
      seeds: context.query.seeds,
      statementCount: materialized.statementCount,
    };
    const updated = updateRunManifest(claim.storage.manifestPath, (manifest) =>
      manifest
        ? touchRunManifest(
            { ...manifest, worldModel: binding },
            binding.generatedAt
          )
        : undefined
    );
    if (!updated) {
      throw new Error(
        `Cannot bind World Model: run manifest is missing at ${claim.storage.manifestPath}`
      );
    }
    return binding;
  } catch (error) {
    store?.close();
    rmSync(temporaryDatabasePath, { force: true });
    rmSync(temporaryContextPath, { force: true });
    throw error;
  }
};
