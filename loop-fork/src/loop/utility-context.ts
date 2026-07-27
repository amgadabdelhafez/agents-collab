import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import {
  MAX_UTILITY_CONTEXT_REFS,
  type UtilityRouteRequest,
} from "./task-router";
import {
  isUtilityContextRefPath,
  normalizeUtilityPolicyPath,
} from "./utility-path-policy";

export const UTILITY_CONTEXT_SCHEMA_VERSION = 1;
export const UTILITY_INSTRUCTIONS_FILE = "UTILITY.instructions.md";
export const MAX_UTILITY_INSTRUCTION_CHARS = 8000;
export const MAX_UTILITY_CONTEXT_REF_CHARS = 3000;
export const MAX_UTILITY_CONTEXT_REFS_CHARS = 12_000;
const MAX_CONTEXT_SOURCE_BYTES = 128 * 1024;
const SAFE_CONTEXT_FILE_STEM_RE = /^[A-Za-z0-9._:-]{1,160}$/;
const READ_NO_FOLLOW_FLAGS = constants.O_RDONLY + constants.O_NOFOLLOW;

export type UtilityContextDocumentStatus =
  | "loaded"
  | "missing"
  | "rejected"
  | "unavailable";

export interface UtilityContextDocument {
  path: string;
  sha256?: string;
  status: UtilityContextDocumentStatus;
  text?: string;
  truncated?: boolean;
}

export interface UtilityContextCapsule {
  projectInstructions: UtilityContextDocument;
  references: UtilityContextDocument[];
  request: UtilityRouteRequest;
  schemaVersion: typeof UTILITY_CONTEXT_SCHEMA_VERSION;
  sha256: string;
  workspace: {
    name: string;
    rootSha256: string;
  };
}

type CapsulePayload = Omit<UtilityContextCapsule, "sha256">;

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const pathIsWithin = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || !(rel.startsWith("..") || isAbsolute(rel));
};

const pathHasSymlinkComponent = (root: string, path: string): boolean => {
  let current = root;
  for (const segment of path.split("/").filter(Boolean)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
};

const loadDocument = (input: {
  charLimit: number;
  path: string;
  repoRoot: string;
}): UtilityContextDocument => {
  const normalized = normalizeUtilityPolicyPath(input.path);
  const fallback = { path: normalized || input.path };
  let stat: ReturnType<typeof lstatSync>;
  const absolute = join(input.repoRoot, normalized);
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    return {
      ...fallback,
      status:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing"
          : "unavailable",
    };
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    pathHasSymlinkComponent(input.repoRoot, normalized) ||
    stat.size > MAX_CONTEXT_SOURCE_BYTES
  ) {
    return { ...fallback, status: "rejected" };
  }
  try {
    const resolved = realpathSync(absolute);
    if (!pathIsWithin(input.repoRoot, resolved)) {
      return { ...fallback, status: "rejected" };
    }
    const fd = openContextFile(resolved);
    let bytes: Buffer;
    try {
      const openedStat = fstatSync(fd);
      if (!openedStat.isFile() || openedStat.size > MAX_CONTEXT_SOURCE_BYTES) {
        return { ...fallback, status: "rejected" };
      }
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    const fullText = bytes.toString("utf8");
    const text = fullText.slice(0, input.charLimit);
    return {
      ...fallback,
      sha256: sha256(bytes),
      status: "loaded",
      text,
      ...(text.length < fullText.length ? { truncated: true } : {}),
    };
  } catch {
    return { ...fallback, status: "unavailable" };
  }
};

const openContextFile = (path: string): number =>
  openSync(path, READ_NO_FOLLOW_FLAGS);

const loadProjectInstructions = (repoRoot: string): UtilityContextDocument =>
  loadDocument({
    charLimit: MAX_UTILITY_INSTRUCTION_CHARS,
    path: UTILITY_INSTRUCTIONS_FILE,
    repoRoot,
  });

const loadReferences = (
  repoRoot: string,
  refs: readonly string[]
): UtilityContextDocument[] => {
  let remaining = MAX_UTILITY_CONTEXT_REFS_CHARS;
  return refs.map((rawRef) => {
    const path = normalizeUtilityPolicyPath(rawRef);
    if (!isUtilityContextRefPath(rawRef)) {
      return { path: path || rawRef, status: "rejected" };
    }
    const document = loadDocument({
      charLimit: Math.min(MAX_UTILITY_CONTEXT_REF_CHARS, remaining),
      path,
      repoRoot,
    });
    if (document.status === "loaded") {
      remaining = Math.max(0, remaining - (document.text?.length ?? 0));
    }
    return document;
  });
};

export const buildUtilityContextCapsule = (input: {
  repoRoot: string;
  request: UtilityRouteRequest;
}): UtilityContextCapsule => {
  const repoRoot = realpathSync(input.repoRoot);
  const payload: CapsulePayload = {
    projectInstructions: loadProjectInstructions(repoRoot),
    references: loadReferences(
      repoRoot,
      (input.request.contextRefs ?? []).slice(0, MAX_UTILITY_CONTEXT_REFS)
    ),
    request: input.request,
    schemaVersion: UTILITY_CONTEXT_SCHEMA_VERSION,
    workspace: {
      name: basename(repoRoot),
      rootSha256: sha256(repoRoot),
    },
  };
  return { ...payload, sha256: sha256(stableJson(payload)) };
};

const safeContextFileStem = (jobId: string): string =>
  SAFE_CONTEXT_FILE_STEM_RE.test(jobId) ? jobId : sha256(jobId);

export const utilityContextPath = (runDir: string, jobId: string): string =>
  join(runDir, "utility", "contexts", `${safeContextFileStem(jobId)}.json`);

export const persistUtilityContextCapsule = (
  runDir: string,
  jobId: string,
  capsule: UtilityContextCapsule
): string => {
  const path = utilityContextPath(runDir, jobId);
  mkdirSync(join(runDir, "utility", "contexts"), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${stableJson(capsule)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  return path;
};

export const utilityContextPrompt = (capsule: UtilityContextCapsule): string =>
  stableJson(capsule);
