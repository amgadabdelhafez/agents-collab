import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

export interface GitResultArtifactBinding {
  artifactRef: string;
  commit: string;
  path: string;
  repositoryRoot: string;
}
const reference = /^artifact:\/\/sha256\/[a-f0-9]{64}$/;
const commitId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const safePath = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const regularBlob = /^(100644|100755) blob [a-f0-9]+\t([^\0]+)\0$/;

/**
 * Process-wide cap on verification git subprocesses. A burst of verification
 * requests queues here instead of forking one git per request; each call keeps
 * its own 5s timeout once it holds a slot, so verdicts are unchanged.
 */
export const MAX_CONCURRENT_ARTIFACT_GIT = 4;
let activeGit = 0;
const gitWaiters: Array<() => void> = [];

const withGitSlot = async <T>(run: () => Promise<T>): Promise<T> => {
  if (activeGit < MAX_CONCURRENT_ARTIFACT_GIT) {
    activeGit += 1;
  } else {
    // The releasing call hands its slot straight to us; the count is unchanged.
    await new Promise<void>((resolve) => gitWaiters.push(resolve));
  }
  try {
    return await run();
  } finally {
    const next = gitWaiters.shift();
    if (next) {
      next();
    } else {
      activeGit -= 1;
    }
  }
};

/** Exact committed bytes only. No worktree fallback, remote access, arbitrary
 * caller path, replace refs, symlink blob, or transcript retrieval. */
export const createGitResultArtifactVerifier = (
  entries: readonly GitResultArtifactBinding[]
) => {
  if (entries.length > 128) {
    throw new Error("Too many result artifact bindings");
  }
  const bindings = new Map<string, GitResultArtifactBinding>();
  for (const entry of entries) {
    if (
      Object.keys(entry).sort().join(",") !==
        "artifactRef,commit,path,repositoryRoot" ||
      !reference.test(entry.artifactRef) ||
      !commitId.test(entry.commit) ||
      !isAbsolute(entry.repositoryRoot) ||
      !safePath.test(entry.path) ||
      entry.path.split("/").some((part) => part === "." || part === "..") ||
      bindings.has(entry.artifactRef)
    ) {
      throw new Error("Invalid or duplicate committed result artifact binding");
    }
    bindings.set(entry.artifactRef, { ...entry });
  }
  return async (artifactRef: string): Promise<boolean> => {
    const binding = bindings.get(artifactRef);
    if (!binding) {
      return false;
    }
    // Asynchronous so a slow repository never stalls the request path. Same
    // bounds as before: non-zero exit, 5s timeout or 1 MiB output rejects.
    const git = (args: string[]) =>
      withGitSlot(
        () =>
          new Promise<Buffer>((resolve, reject) => {
            const child = execFile(
              "git",
              ["--no-replace-objects", "-C", binding.repositoryRoot, ...args],
              { encoding: "buffer", maxBuffer: 1024 * 1024, timeout: 5000 },
              (error, stdout) => (error ? reject(error) : resolve(stdout))
            );
            child.stdin?.end();
          })
      );
    try {
      if (
        (await git(["cat-file", "-t", binding.commit])).toString().trim() !==
        "commit"
      ) {
        return false;
      }
      const tree = (
        await git(["ls-tree", "-z", binding.commit, "--", binding.path])
      ).toString();
      const match = regularBlob.exec(tree);
      if (!match || match[2] !== binding.path) {
        return false;
      }
      const bytes = await git(["show", `${binding.commit}:${binding.path}`]);
      return (
        `artifact://sha256/${createHash("sha256").update(bytes).digest("hex")}` ===
        artifactRef
      );
    } catch {
      return false;
    }
  };
};
