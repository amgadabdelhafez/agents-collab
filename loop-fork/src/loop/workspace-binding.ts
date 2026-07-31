import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { type GitResult, runGit as runGitCommand } from "./git";
import { resolveRepoId } from "./run-state";
import type { LaunchWorkspaceBinding } from "./types";

interface WorkspaceBindingDeps {
  isDirectory: (path: string) => boolean;
  pathExists: (path: string) => boolean;
  realpath: (path: string) => string;
  runGit: (cwd: string, args: string[]) => GitResult;
}

const defaultDeps: WorkspaceBindingDeps = {
  isDirectory: (path) => statSync(path).isDirectory(),
  pathExists: (path) => existsSync(path),
  realpath: (path) => realpathSync(path),
  runGit: (cwd, args) => runGitCommand(cwd, args),
};

const gitDetail = (result: GitResult): string => {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail ? `: ${detail}` : "";
};

const canonicalExistingDirectory = (
  path: string,
  deps: WorkspaceBindingDeps
): string => {
  if (!deps.pathExists(path)) {
    throw new Error(`[loop] workspace path does not exist: ${path}`);
  }
  let canonical: string;
  try {
    canonical = deps.realpath(path);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `[loop] failed to canonicalize workspace path ${path}${detail}`
    );
  }
  if (!deps.isDirectory(canonical)) {
    throw new Error(`[loop] workspace path is not a directory: ${path}`);
  }
  return canonical;
};

const registeredWorktreeRoots = (
  root: string,
  deps: WorkspaceBindingDeps
): Set<string> => {
  const result = deps.runGit(root, ["worktree", "list", "--porcelain", "-z"]);
  if (result.exitCode !== 0) {
    throw new Error(
      `[loop] failed to inspect registered Git worktrees for "${root}"${gitDetail(result)}`
    );
  }

  const roots = new Set<string>();
  for (const field of result.stdout.split("\0")) {
    if (!field.startsWith("worktree ")) {
      continue;
    }
    const listed = field.slice("worktree ".length);
    try {
      roots.add(deps.realpath(listed));
    } catch {
      // A stale registration is not evidence that the requested path is live.
    }
  }
  return roots;
};

const resolveGitRoot = (
  candidate: string,
  explicit: boolean,
  deps: WorkspaceBindingDeps
): string | undefined => {
  const result = deps.runGit(candidate, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
  ]);
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    if (explicit) {
      throw new Error(
        `[loop] workspace "${candidate}" is not a registered Git worktree${gitDetail(result)}`
      );
    }
    return undefined;
  }

  const root = canonicalExistingDirectory(
    isAbsolute(result.stdout.trim())
      ? result.stdout.trim()
      : resolve(candidate, result.stdout.trim()),
    deps
  );
  if (!registeredWorktreeRoots(root, deps).has(root)) {
    throw new Error(
      `[loop] workspace "${candidate}" resolves to unregistered Git worktree "${root}"`
    );
  }
  return root;
};

const resolveBranchRef = (
  root: string,
  deps: WorkspaceBindingDeps
): string | undefined => {
  const result = deps.runGit(root, ["symbolic-ref", "-q", "HEAD"]);
  if (result.exitCode === 1) {
    return undefined;
  }
  const branchRef = result.stdout.trim();
  if (result.exitCode !== 0 || !branchRef) {
    throw new Error(
      `[loop] failed to resolve symbolic branch for workspace "${root}"${gitDetail(result)}`
    );
  }
  if (!branchRef.startsWith("refs/heads/")) {
    throw new Error(
      `[loop] workspace "${root}" resolved invalid branch ref "${branchRef}"`
    );
  }
  return branchRef;
};

export const resolveWorkspaceBinding = (
  requestedPath: string | undefined,
  invocationCwd: string,
  overrides: Partial<WorkspaceBindingDeps> = {}
): LaunchWorkspaceBinding => {
  const deps = { ...defaultDeps, ...overrides };
  const explicit = requestedPath !== undefined;
  if (explicit && !requestedPath.trim()) {
    throw new Error("[loop] workspace path cannot be empty");
  }
  const requested = requestedPath ?? invocationCwd;
  const absolute = isAbsolute(requested)
    ? resolve(requested)
    : resolve(invocationCwd, requested);
  const candidate = canonicalExistingDirectory(absolute, deps);
  const gitRoot = resolveGitRoot(candidate, explicit, deps);
  const root = gitRoot ?? candidate;
  const repoId = resolveRepoId(root, {
    runGit: (args) => deps.runGit(root, args),
  });
  const branchRef = gitRoot ? resolveBranchRef(root, deps) : undefined;
  return {
    ...(branchRef ? { branchRef } : {}),
    repoId,
    root,
  };
};

export const workspaceBindingInternals = {
  registeredWorktreeRoots,
  resolveBranchRef,
  resolveGitRoot,
};
