import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isEffortLevel } from "./effort";
import type { Agent, EffortLevel } from "./types";

export interface GovernessHandoffBundle {
  agent: Agent;
  blockers: string[];
  checks: string[];
  dirtyFiles: string[];
  epoch: number;
  gitHead: string;
  next: string;
  status: "ready";
  summary: string;
}

export interface GovernessHandoffManifest {
  bundles: Partial<Record<Agent, { digest: string; path: string }>>;
  continuation: { digest: string; path: string };
  createdAt: string;
  digest: string;
  driverEffort: EffortLevel;
  epoch: number;
  reviewerEffort: EffortLevel;
}

export interface GovernessHandoffEffort {
  driverEffort: EffortLevel;
  reviewerEffort: EffortLevel;
}

export interface GovernessHandoffAcceptance {
  acceptedAt: string;
  manifestDigest: string;
  replacementEpoch: number;
  replacementSession: string;
}

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const writeAtomicJson = (path: string, value: unknown): void => {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
};

export const governessHandoffDir = (runDir: string, epoch: number): string =>
  join(runDir, "handoff", String(epoch));

export const governessHandoffFile = (
  runDir: string,
  epoch: number,
  agent: Agent
): string => join(governessHandoffDir(runDir, epoch), `${agent}.json`);

export const governessHandoffManifestFile = (
  runDir: string,
  epoch: number
): string => join(governessHandoffDir(runDir, epoch), "manifest.json");

export const governessHandoffAcceptanceFile = (manifestFile: string): string =>
  join(manifestFile, "..", "acceptance.json");

export const ensureGovernessHandoffDir = (
  runDir: string,
  epoch: number
): string => {
  const path = governessHandoffDir(runDir, epoch);
  mkdirSync(path, { recursive: true });
  return path;
};
export const readGovernessHandoffBundle = (
  path: string,
  expectedAgent: Agent,
  epoch: number
): GovernessHandoffBundle | undefined => {
  const value = readGovernessHandoffBundleForAgent(path, expectedAgent);
  return value?.epoch === epoch ? value : undefined;
};

export const readGovernessHandoffBundleForAgent = (
  path: string,
  expectedAgent: Agent
): GovernessHandoffBundle | undefined => {
  try {
    const value = JSON.parse(
      readFileSync(path, "utf8")
    ) as Partial<GovernessHandoffBundle>;
    if (
      value.agent !== expectedAgent ||
      typeof value.epoch !== "number" ||
      !Number.isSafeInteger(value.epoch) ||
      value.epoch < 0 ||
      value.status !== "ready" ||
      typeof value.gitHead !== "string" ||
      typeof value.next !== "string" ||
      typeof value.summary !== "string" ||
      !Array.isArray(value.blockers) ||
      !Array.isArray(value.checks) ||
      !Array.isArray(value.dirtyFiles)
    ) {
      return undefined;
    }
    return value as GovernessHandoffBundle;
  } catch {
    return undefined;
  }
};

export const writeGovernessHandoffManifest = (
  runDir: string,
  epoch: number,
  agents: Agent[],
  nowIso: string,
  continuationFile: string,
  effort: GovernessHandoffEffort
): string | undefined => {
  if (
    !(
      isEffortLevel(effort.driverEffort) && isEffortLevel(effort.reviewerEffort)
    )
  ) {
    return undefined;
  }
  const bundles: GovernessHandoffManifest["bundles"] = {};
  for (const agent of agents) {
    const path = governessHandoffFile(runDir, epoch, agent);
    const bundle = readGovernessHandoffBundle(path, agent, epoch);
    if (!bundle) {
      return undefined;
    }
    bundles[agent] = { digest: digest(readFileSync(path, "utf8")), path };
  }
  let continuation: GovernessHandoffManifest["continuation"];
  try {
    continuation = {
      digest: digest(readFileSync(continuationFile, "utf8")),
      path: continuationFile,
    };
  } catch {
    return undefined;
  }
  const canonical = JSON.stringify({
    bundles,
    continuation,
    driverEffort: effort.driverEffort,
    epoch,
    reviewerEffort: effort.reviewerEffort,
  });
  const manifest: GovernessHandoffManifest = {
    bundles,
    continuation,
    createdAt: nowIso,
    digest: digest(canonical),
    driverEffort: effort.driverEffort,
    epoch,
    reviewerEffort: effort.reviewerEffort,
  };
  const path = governessHandoffManifestFile(runDir, epoch);
  writeAtomicJson(path, manifest);
  return path;
};

export const readGovernessHandoffManifest = (
  manifestFile: string
): GovernessHandoffManifest | undefined => {
  try {
    const value = JSON.parse(
      readFileSync(manifestFile, "utf8")
    ) as Partial<GovernessHandoffManifest>;
    if (
      typeof value.epoch !== "number" ||
      typeof value.createdAt !== "string" ||
      typeof value.digest !== "string" ||
      !isEffortLevel(value.driverEffort ?? "") ||
      !isEffortLevel(value.reviewerEffort ?? "") ||
      !value.bundles ||
      typeof value.bundles !== "object" ||
      !value.continuation ||
      typeof value.continuation.digest !== "string" ||
      typeof value.continuation.path !== "string" ||
      value.continuation.path !== join(dirname(manifestFile), "continuation.md")
    ) {
      return undefined;
    }
    const canonical = JSON.stringify({
      bundles: value.bundles,
      continuation: value.continuation,
      driverEffort: value.driverEffort,
      epoch: value.epoch,
      reviewerEffort: value.reviewerEffort,
    });
    if (digest(canonical) !== value.digest) {
      return undefined;
    }
    if (
      digest(readFileSync(value.continuation.path, "utf8")) !==
      value.continuation.digest
    ) {
      return undefined;
    }
    for (const [agent, entry] of Object.entries(value.bundles)) {
      if (
        !entry ||
        typeof entry.digest !== "string" ||
        typeof entry.path !== "string" ||
        digest(readFileSync(entry.path, "utf8")) !== entry.digest ||
        !readGovernessHandoffBundle(entry.path, agent as Agent, value.epoch)
      ) {
        return undefined;
      }
    }
    return value as GovernessHandoffManifest;
  } catch {
    return undefined;
  }
};

export const acceptGovernessHandoff = (
  manifestFile: string,
  replacementSession: string,
  replacementEpoch: number,
  nowIso: string
): GovernessHandoffAcceptance | undefined => {
  const manifest = readGovernessHandoffManifest(manifestFile);
  if (!manifest) {
    return undefined;
  }
  const acceptance: GovernessHandoffAcceptance = {
    acceptedAt: nowIso,
    manifestDigest: manifest.digest,
    replacementEpoch,
    replacementSession,
  };
  writeAtomicJson(governessHandoffAcceptanceFile(manifestFile), acceptance);
  return acceptance;
};

export const readGovernessHandoffAcceptance = (
  manifestFile: string,
  replacementSession: string
): GovernessHandoffAcceptance | undefined => {
  const manifest = readGovernessHandoffManifest(manifestFile);
  if (!manifest) {
    return undefined;
  }
  try {
    const value = JSON.parse(
      readFileSync(governessHandoffAcceptanceFile(manifestFile), "utf8")
    ) as Partial<GovernessHandoffAcceptance>;
    if (
      value.manifestDigest !== manifest.digest ||
      value.replacementSession !== replacementSession ||
      typeof value.replacementEpoch !== "number" ||
      value.replacementEpoch <= manifest.epoch ||
      typeof value.acceptedAt !== "string"
    ) {
      return undefined;
    }
    return value as GovernessHandoffAcceptance;
  } catch {
    return undefined;
  }
};
