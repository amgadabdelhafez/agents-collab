import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isWebUiSnapshot } from "../../../../src/webui/api.ts";
import { readLoopRegistryLiveSnapshot } from "../../../../src/webui/server/harvto-live-data.ts";

const storageRoot = join(process.env.HOME ?? process.cwd(), ".loop", "runs");
const snapshot = readLoopRegistryLiveSnapshot({ storageRoot });
if (!isWebUiSnapshot(snapshot)) {
  throw new Error("the live response failed its public DTO validator");
}
if (snapshot.fleet.runs.length === 0) {
  throw new Error("no active loop was available for the live redaction check");
}

const response = JSON.stringify(snapshot);
const sensitiveKey =
  /(message|objective|summary|reason|detail|prompt|cwd|root|path|socket|session|thread|claim|signature|credential|token|secret|password|content|payload|request|response|result|error|transcript|workspace|charter|world|context|capsule|command|args|argv|url|uri)/iu;
const sensitiveValues = new Set<string>();

const collectSensitiveValues = (value: unknown, key = ""): void => {
  if (typeof value === "string") {
    if (sensitiveKey.test(key) && value.length >= 8) {
      sensitiveValues.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSensitiveValues(item, key);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [childKey, child] of Object.entries(value)) {
      collectSensitiveValues(child, childKey);
    }
  }
};

const evidenceFiles = [
  "manifest.json",
  "governess-state.json",
  "bridge.jsonl",
  "bridge-reconciliation.json",
  "utility/jobs.jsonl",
  "hooks/claude.jsonl",
  "hooks/codex.jsonl",
] as const;

for (const run of snapshot.fleet.runs) {
  const runDir = join(storageRoot, run.repoId, run.runId);
  for (const relativePath of evidenceFiles) {
    const evidencePath = join(runDir, relativePath);
    try {
      const stat = lstatSync(evidencePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        continue;
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        readFileSync(evidencePath)
      );
      if (relativePath.endsWith(".jsonl")) {
        for (const line of text.split(/\r?\n/u)) {
          if (line.trim()) {
            collectSensitiveValues(JSON.parse(line));
          }
        }
      } else {
        collectSensitiveValues(JSON.parse(text));
      }
    } catch {
      // Invalid or absent optional evidence cannot contribute to the projection.
    }
  }
}

const leakedValues = [...sensitiveValues].filter((value) =>
  response.includes(value)
);
const leakFingerprints = leakedValues.map((value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 12)
);
const absolutePaths =
  response.match(/\/(?:Users|private|tmp)\/[A-Za-z0-9._~!$&()+,;=:@%/-]+/gu) ??
  [];
const rawRuntimeFields = ["tmuxSocket", "tmuxSession"].filter((key) =>
  response.includes(key)
);

const report = {
  absolutePathLeakCount: absolutePaths.length,
  activeRoutes: snapshot.fleet.runs.map((run) => run.routeId),
  candidateSensitiveValueCount: sensitiveValues.size,
  detailCount: Object.keys(snapshot.details).length,
  leakFingerprints,
  leakedValueCount: leakedValues.length,
  rawRuntimeFieldCount: rawRuntimeFields.length,
  source: snapshot.source,
  valid: true,
};

console.log(JSON.stringify(report, null, 2));
if (
  leakedValues.length > 0 ||
  absolutePaths.length > 0 ||
  rawRuntimeFields.length > 0
) {
  process.exit(1);
}
