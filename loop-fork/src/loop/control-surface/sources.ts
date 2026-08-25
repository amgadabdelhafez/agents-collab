import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type {
  ReadModelCapabilities,
  RunLocator,
  RunSourceSnapshots,
  SourceKind,
  SourceSnapshot,
} from "./types";

interface SnapshotOptions {
  kind?: SourceKind;
  maxBytes: number;
  observedAt: number;
}

const LINE_SPLIT_RE = /\r?\n/u;

const revisionOf = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const decodeUtf8 = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);

const readBytes = (
  path: string,
  options: SnapshotOptions
): SourceSnapshot<Uint8Array> => {
  const kind = options.kind ?? "manifest";
  try {
    const stats = statSync(path);
    if (!stats.isFile()) {
      return { kind, observedAt: options.observedAt, status: "unavailable" };
    }
    if (stats.size > options.maxBytes) {
      return { kind, observedAt: options.observedAt, status: "oversize" };
    }
    const bytes = readFileSync(path);
    return {
      kind,
      observedAt: options.observedAt,
      recordedAt: stats.mtimeMs,
      revision: revisionOf(bytes),
      status: "available",
      value: bytes,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      detail: code === "ENOENT" ? undefined : "read-failed",
      kind,
      observedAt: options.observedAt,
      status: code === "ENOENT" ? "missing" : "unavailable",
    };
  }
};

const parseSnapshot = <T>(
  path: string,
  options: SnapshotOptions,
  parse: (text: string) => T
): SourceSnapshot<T> => {
  const raw = readBytes(path, options);
  if (raw.status !== "available" || !raw.value) {
    return raw as SourceSnapshot<T>;
  }
  try {
    return { ...raw, value: parse(decodeUtf8(raw.value)) };
  } catch {
    const { value: _value, ...metadata } = raw;
    return { ...metadata, detail: "parse-failed", status: "malformed" };
  }
};

export const readJsonSnapshot = <T = unknown>(
  path: string,
  options: SnapshotOptions
): SourceSnapshot<T> => parseSnapshot(path, options, JSON.parse);

export const readJsonlSnapshot = <T = unknown>(
  path: string,
  options: SnapshotOptions
): SourceSnapshot<T[]> =>
  parseSnapshot(path, options, (text) =>
    text
      .split(LINE_SPLIT_RE)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T)
  );

export const assertContainedPath = (
  root: string,
  candidate: string
): string => {
  const safeRoot = resolve(root);
  const safeCandidate = resolve(candidate);
  const offset = relative(safeRoot, safeCandidate);
  if (
    !offset ||
    offset.startsWith("..") ||
    resolve(safeRoot, offset) !== safeCandidate
  ) {
    throw new Error("Evidence path is outside the selected run directory");
  }
  return safeCandidate;
};

const unavailable = (kind: SourceKind, observedAt: number): SourceSnapshot => ({
  kind,
  observedAt,
  status: "unavailable",
});

const listDirectories = (path: string): string[] => {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
};

const readHooks = (runDir: string, observedAt: number): SourceSnapshot => {
  const directory = join(runDir, "hooks");
  let names: string[];
  try {
    names = readdirSync(directory)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "hooks", observedAt, status: "missing" }
      : unavailable("hooks", observedAt);
  }
  const parts = names.map((name) =>
    readJsonlSnapshot(assertContainedPath(runDir, join(directory, name)), {
      kind: "hooks",
      maxBytes: 2 * 1024 * 1024,
      observedAt,
    })
  );
  const failed = parts.find((part) => part.status !== "available");
  if (failed) {
    return failed;
  }
  return {
    kind: "hooks",
    observedAt,
    recordedAt: Math.max(0, ...parts.map((part) => part.recordedAt ?? 0)),
    revision: revisionOf(
      new TextEncoder().encode(parts.map((part) => part.revision).join("\n"))
    ),
    status: "available",
    value: parts.flatMap((part) => part.value ?? []),
  };
};

export const createFilesystemReadModelCapabilities = (
  storageRoot: string,
  now: () => number = Date.now
): ReadModelCapabilities => {
  const safeStorageRoot = resolve(storageRoot);
  const listRuns = (): RunLocator[] =>
    listDirectories(safeStorageRoot).flatMap((repoId) =>
      listDirectories(join(safeStorageRoot, repoId)).map((runId) => ({
        repoId,
        runId,
        runDir: join(safeStorageRoot, repoId, runId),
        storageRoot: safeStorageRoot,
      }))
    );
  const readSources = (locator: RunLocator): RunSourceSnapshots => {
    const observedAt = now();
    if (
      resolve(locator.storageRoot) !== safeStorageRoot ||
      resolve(locator.runDir) !==
        resolve(safeStorageRoot, locator.repoId, locator.runId)
    ) {
      throw new Error("Run locator is outside the configured storage root");
    }
    const json = (kind: SourceKind, name: string, maxBytes = 2 * 1024 * 1024) =>
      readJsonSnapshot(
        assertContainedPath(locator.runDir, join(locator.runDir, name)),
        {
          kind,
          maxBytes,
          observedAt,
        }
      );
    const jsonl = (
      kind: SourceKind,
      name: string,
      maxBytes = 8 * 1024 * 1024
    ) =>
      readJsonlSnapshot(
        assertContainedPath(locator.runDir, join(locator.runDir, name)),
        {
          kind,
          maxBytes,
          observedAt,
        }
      );
    const manifest = json("manifest", "manifest.json");
    const manifestValue = manifest.value as Record<string, unknown> | undefined;
    const adapter: SourceSnapshot =
      manifest.status === "available"
        ? {
            kind: "adapter",
            observedAt,
            recordedAt: manifest.recordedAt,
            revision: manifest.revision,
            status: "available",
            value: manifestValue?.tmuxAdapterIdentity,
          }
        : { ...manifest, kind: "adapter" };
    return {
      adapter,
      bridge: jsonl("bridge", "bridge.jsonl"),
      "governess-control": jsonl(
        "governess-control",
        "governess-control.jsonl"
      ),
      "governess-state": json("governess-state", "governess-state.json"),
      hooks: readHooks(locator.runDir, observedAt),
      manifest,
      transcript: jsonl("transcript", "transcript.jsonl"),
      usage: jsonl("usage", "utility/usage.jsonl"),
      utility: jsonl("utility", "utility/tool-events.jsonl"),
    };
  };
  return { listRuns, now, readSources };
};
