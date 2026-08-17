import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isEffortLevel } from "./effort";
import {
  type RunHandoffLineage,
  type RunLaunchIdentity,
  readRunHandoffLineage,
  readRunLaunchIdentity,
  readRunManifest,
  replacementMatchesSourceIdentity,
  runLaunchIdentityDigest,
} from "./run-state";
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
  sourceIdentity: RunLaunchIdentity;
  sourceManifestIdentityDigest: string;
}

export interface GovernessHandoffEffort {
  driverEffort: EffortLevel;
  reviewerEffort: EffortLevel;
}

export interface GovernessHandoffAcceptance {
  acceptedAt: string;
  manifestDigest: string;
  replacementEpoch: number;
  replacementManifestIdentityDigest: string;
  replacementManifestPath: string;
  replacementRepoId: string;
  replacementRunId: string;
  replacementSession: string;
  sourceManifestIdentityDigest: string;
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
  effort: GovernessHandoffEffort,
  sourceIdentityInput: RunLaunchIdentity
): string | undefined => {
  const sourceIdentity = readRunLaunchIdentity(sourceIdentityInput);
  if (
    !(
      isEffortLevel(effort.driverEffort) &&
      isEffortLevel(effort.reviewerEffort) &&
      sourceIdentity &&
      sourceIdentity.primary.effort === effort.driverEffort &&
      sourceIdentity.peer.effort === effort.reviewerEffort &&
      agents.length === 2 &&
      new Set(agents).size === 2 &&
      agents.includes(sourceIdentity.primary.agent) &&
      agents.includes(sourceIdentity.peer.agent)
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
    sourceIdentity,
    sourceManifestIdentityDigest: runLaunchIdentityDigest(sourceIdentity),
  });
  const manifest: GovernessHandoffManifest = {
    bundles,
    continuation,
    createdAt: nowIso,
    digest: digest(canonical),
    driverEffort: effort.driverEffort,
    epoch,
    reviewerEffort: effort.reviewerEffort,
    sourceIdentity,
    sourceManifestIdentityDigest: runLaunchIdentityDigest(sourceIdentity),
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
    const sourceIdentity = readRunLaunchIdentity(value.sourceIdentity);
    if (
      typeof value.epoch !== "number" ||
      typeof value.createdAt !== "string" ||
      typeof value.digest !== "string" ||
      !isEffortLevel(value.driverEffort ?? "") ||
      !isEffortLevel(value.reviewerEffort ?? "") ||
      !sourceIdentity ||
      value.sourceManifestIdentityDigest !==
        runLaunchIdentityDigest(sourceIdentity) ||
      sourceIdentity.primary.effort !== value.driverEffort ||
      sourceIdentity.peer.effort !== value.reviewerEffort ||
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
      sourceIdentity,
      sourceManifestIdentityDigest: value.sourceManifestIdentityDigest,
    });
    if (digest(canonical) !== value.digest) {
      return undefined;
    }
    const bundleAgents = Object.keys(value.bundles);
    if (
      bundleAgents.length !== 2 ||
      !bundleAgents.includes(sourceIdentity.primary.agent) ||
      !bundleAgents.includes(sourceIdentity.peer.agent)
    ) {
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
    return { ...value, sourceIdentity } as GovernessHandoffManifest;
  } catch {
    return undefined;
  }
};

export const handoffLineageForReplacement = (
  manifest: GovernessHandoffManifest,
  replacementIdentity: RunLaunchIdentity
): RunHandoffLineage | undefined => {
  if (
    !replacementMatchesSourceIdentity(
      manifest.sourceIdentity,
      replacementIdentity
    )
  ) {
    return undefined;
  }
  return readRunHandoffLineage({
    handoffDigest: manifest.digest,
    handoffEpoch: manifest.epoch,
    sourceIdentity: manifest.sourceIdentity,
    sourceManifestIdentityDigest: manifest.sourceManifestIdentityDigest,
  });
};

const replacementManifestMatchesIdentity = (
  manifestPath: string,
  handoff: GovernessHandoffManifest,
  replacementSession: string
) => {
  const replacement = readRunManifest(manifestPath);
  const identity = replacement?.launchIdentity;
  const expectedLineage = identity
    ? handoffLineageForReplacement(handoff, identity)
    : undefined;
  if (
    !(
      replacement &&
      identity &&
      expectedLineage &&
      replacement.handoffLineage &&
      replacement.runId === identity.runId &&
      replacement.repoId === identity.repoId &&
      replacement.cwd === identity.cwd &&
      replacement.driverEffort === identity.primary.effort &&
      replacement.reviewerEffort === identity.peer.effort &&
      replacement.primaryAgent === identity.primary.agent &&
      replacement.tmuxSession === replacementSession &&
      replacement.tmuxPaneLeftAgent &&
      replacement.tmuxPaneRightAgent &&
      new Set([replacement.tmuxPaneLeftAgent, replacement.tmuxPaneRightAgent])
        .size === 2 &&
      [replacement.tmuxPaneLeftAgent, replacement.tmuxPaneRightAgent].includes(
        identity.primary.agent
      ) &&
      [replacement.tmuxPaneLeftAgent, replacement.tmuxPaneRightAgent].includes(
        identity.peer.agent
      ) &&
      replacement.workspaceBinding?.root === identity.workspaceBinding.root &&
      replacement.workspaceBinding.repoId ===
        identity.workspaceBinding.repoId &&
      replacement.workspaceBinding.branchRef ===
        identity.workspaceBinding.branchRef &&
      JSON.stringify(replacement.handoffLineage) ===
        JSON.stringify(expectedLineage)
    )
  ) {
    return undefined;
  }
  return { identity, replacement };
};

export const acceptGovernessHandoff = (
  manifestFile: string,
  replacementSession: string,
  replacementEpoch: number,
  nowIso: string,
  replacementManifestPath: string
): GovernessHandoffAcceptance | undefined => {
  const acceptanceFile = governessHandoffAcceptanceFile(manifestFile);
  if (existsSync(acceptanceFile)) {
    return readGovernessHandoffAcceptance(manifestFile, replacementSession);
  }
  const manifest = readGovernessHandoffManifest(manifestFile);
  if (!(manifest && replacementEpoch > manifest.epoch)) {
    return undefined;
  }
  const matched = replacementManifestMatchesIdentity(
    replacementManifestPath,
    manifest,
    replacementSession
  );
  if (!matched) {
    return undefined;
  }
  const acceptance: GovernessHandoffAcceptance = {
    acceptedAt: nowIso,
    manifestDigest: manifest.digest,
    replacementEpoch,
    replacementManifestIdentityDigest: runLaunchIdentityDigest(
      matched.identity
    ),
    replacementManifestPath,
    replacementRepoId: matched.replacement.repoId,
    replacementRunId: matched.replacement.runId,
    replacementSession,
    sourceManifestIdentityDigest: manifest.sourceManifestIdentityDigest,
  };
  writeAtomicJson(acceptanceFile, acceptance);
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
      typeof value.acceptedAt !== "string" ||
      typeof value.replacementManifestPath !== "string" ||
      typeof value.replacementManifestIdentityDigest !== "string" ||
      typeof value.replacementRunId !== "string" ||
      typeof value.replacementRepoId !== "string" ||
      value.sourceManifestIdentityDigest !==
        manifest.sourceManifestIdentityDigest
    ) {
      return undefined;
    }
    const matched = replacementManifestMatchesIdentity(
      value.replacementManifestPath,
      manifest,
      replacementSession
    );
    if (
      !matched ||
      matched.replacement.runId !== value.replacementRunId ||
      matched.replacement.repoId !== value.replacementRepoId ||
      runLaunchIdentityDigest(matched.identity) !==
        value.replacementManifestIdentityDigest
    ) {
      return undefined;
    }
    return value as GovernessHandoffAcceptance;
  } catch {
    return undefined;
  }
};
