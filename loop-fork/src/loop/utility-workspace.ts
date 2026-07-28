import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { runGit } from "./git";
import type {
  UtilityResolvedWorkspace,
  UtilityRouteRequest,
} from "./task-router";

export interface UtilityWorkspaceResolution {
  request: UtilityRouteRequest;
  workspace?: UtilityResolvedWorkspace;
}

export interface UtilityWorkspaceFailure {
  detail: string;
}

const isContained = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === "" || !(rel.startsWith("..") || isAbsolute(rel));
};

const nearestExistingPath = (value: string): string | undefined => {
  let candidate = resolve(value);
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) {
      return undefined;
    }
    candidate = parent;
  }
  return candidate;
};

const canonicalTarget = (value: string): string | undefined => {
  const absolute = resolve(value);
  const existing = nearestExistingPath(absolute);
  if (!existing) {
    return undefined;
  }
  try {
    return resolve(realpathSync(existing), relative(existing, absolute));
  } catch {
    return undefined;
  }
};

interface GitWorkspaceIdentity {
  commonDir: string;
  root: string;
}

const registeredWorktreeRoots = (runRoot: string): Set<string> | undefined => {
  const result = runGit(runRoot, ["worktree", "list", "--porcelain"], "ignore");
  if (result.exitCode !== 0) {
    return undefined;
  }
  const roots = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) {
      continue;
    }
    try {
      roots.add(realpathSync(line.slice("worktree ".length).trim()));
    } catch {
      // Stale worktree registrations are not valid execution roots.
    }
  }
  return roots;
};

const gitWorkspaceIdentity = (
  path: string
): GitWorkspaceIdentity | undefined => {
  const existing = nearestExistingPath(path);
  if (!existing) {
    return undefined;
  }
  let cwd = existing;
  try {
    if (!statSync(cwd).isDirectory()) {
      cwd = dirname(cwd);
    }
  } catch {
    return undefined;
  }
  const topLevel = runGit(cwd, ["rev-parse", "--show-toplevel"], "ignore");
  const commonDir = runGit(cwd, ["rev-parse", "--git-common-dir"], "ignore");
  if (
    topLevel.exitCode !== 0 ||
    commonDir.exitCode !== 0 ||
    !topLevel.stdout.trim() ||
    !commonDir.stdout.trim()
  ) {
    return undefined;
  }
  try {
    return {
      commonDir: realpathSync(resolve(cwd, commonDir.stdout.trim())),
      root: realpathSync(topLevel.stdout.trim()),
    };
  } catch {
    return undefined;
  }
};

const mismatch = (detail: string): UtilityWorkspaceFailure => ({ detail });

export const resolveVerifiedUtilityWorkspaceRoot = (
  runRoot: string,
  path: string
): string | undefined => {
  let canonicalRunRoot: string;
  try {
    canonicalRunRoot = realpathSync(runRoot);
  } catch {
    return undefined;
  }
  const target = canonicalTarget(path);
  if (!target) {
    return undefined;
  }
  if (isContained(canonicalRunRoot, target)) {
    return canonicalRunRoot;
  }
  const runIdentity = gitWorkspaceIdentity(canonicalRunRoot);
  const targetIdentity = gitWorkspaceIdentity(target);
  const registeredRoots = registeredWorktreeRoots(canonicalRunRoot);
  if (
    !(runIdentity && targetIdentity) ||
    runIdentity.commonDir !== targetIdentity.commonDir ||
    !registeredRoots?.has(targetIdentity.root) ||
    !isContained(targetIdentity.root, target)
  ) {
    return undefined;
  }
  return targetIdentity.root;
};

const relativeWorkspaceResolution = (
  request: UtilityRouteRequest,
  root: string
): UtilityWorkspaceResolution => ({
  request,
  workspace: {
    ...(request.executionCwd ? { executionCwd: request.executionCwd } : {}),
    ...(request.executionOutput
      ? { executionOutput: request.executionOutput }
      : {}),
    ...(request.executionPlan ? { executionPlan: request.executionPlan } : {}),
    ...(request.executionRead ? { executionRead: request.executionRead } : {}),
    readScope: request.readScope,
    root,
    writeScope: request.writeScope,
  },
});

export const resolveUtilityRequestWorkspace = (
  request: UtilityRouteRequest,
  runRoot: string
): UtilityWorkspaceResolution | UtilityWorkspaceFailure => {
  let canonicalRunRoot: string;
  try {
    canonicalRunRoot = realpathSync(runRoot);
  } catch {
    return mismatch("run workspace root is unavailable");
  }
  const scopes = [
    ...request.readScope,
    ...request.writeScope,
    ...(request.executionCwd ? [request.executionCwd] : []),
    ...(request.executionRead ? [request.executionRead.path] : []),
    ...(request.executionPlan
      ? request.executionPlan.flatMap((step) => [
          ...step.readScope,
          ...(step.executionCwd ? [step.executionCwd] : []),
          ...(step.executionRead ? [step.executionRead.path] : []),
        ])
      : []),
  ];
  if (scopes.every((scope) => !isAbsolute(scope))) {
    return relativeWorkspaceResolution(request, canonicalRunRoot);
  }

  const runIdentity = gitWorkspaceIdentity(canonicalRunRoot);
  const registeredRoots = registeredWorktreeRoots(canonicalRunRoot);
  let selectedRoot: string | undefined;
  const normalizeScopes = (values: readonly string[]): string[] | undefined => {
    const normalized: string[] = [];
    for (const value of values) {
      if (!isAbsolute(value)) {
        if (selectedRoot && selectedRoot !== canonicalRunRoot) {
          return undefined;
        }
        selectedRoot = canonicalRunRoot;
        normalized.push(value);
        continue;
      }
      const target = canonicalTarget(value);
      if (!target) {
        return undefined;
      }
      let workspaceRoot = canonicalRunRoot;
      if (!isContained(canonicalRunRoot, target)) {
        const identity = gitWorkspaceIdentity(target);
        if (
          !(runIdentity && identity) ||
          identity.commonDir !== runIdentity.commonDir ||
          !registeredRoots?.has(identity.root) ||
          !isContained(identity.root, target)
        ) {
          return undefined;
        }
        workspaceRoot = identity.root;
      }
      if (selectedRoot && selectedRoot !== workspaceRoot) {
        return undefined;
      }
      selectedRoot = workspaceRoot;
      const scoped = relative(workspaceRoot, target).replaceAll("\\", "/");
      normalized.push(scoped || ".");
    }
    return normalized;
  };

  const readScope = normalizeScopes(request.readScope);
  const writeScope = normalizeScopes(request.writeScope);
  const executionCwd = request.executionCwd
    ? normalizeScopes([request.executionCwd])?.[0]
    : undefined;
  const executionReadPath = request.executionRead
    ? normalizeScopes([request.executionRead.path])?.[0]
    : undefined;
  let executionPlan = request.executionPlan;
  let executionPlanIsValid = true;
  if (request.executionPlan) {
    executionPlan = [];
    for (const step of request.executionPlan) {
      const stepReadScope = normalizeScopes(step.readScope);
      const stepExecutionCwd = step.executionCwd
        ? normalizeScopes([step.executionCwd])?.[0]
        : undefined;
      const stepExecutionReadPath = step.executionRead
        ? normalizeScopes([step.executionRead.path])?.[0]
        : undefined;
      if (
        !stepReadScope ||
        (step.executionCwd !== undefined && !stepExecutionCwd) ||
        (step.executionRead !== undefined && !stepExecutionReadPath)
      ) {
        executionPlanIsValid = false;
        break;
      }
      executionPlan.push({
        ...step,
        ...(stepExecutionCwd ? { executionCwd: stepExecutionCwd } : {}),
        ...(step.executionRead && stepExecutionReadPath
          ? {
              executionRead: {
                ...step.executionRead,
                path: stepExecutionReadPath,
              },
            }
          : {}),
        readScope: stepReadScope,
      });
    }
  }
  if (
    !(
      readScope &&
      writeScope &&
      selectedRoot &&
      executionPlanIsValid &&
      (request.executionCwd === undefined || executionCwd) &&
      (request.executionRead === undefined || executionReadPath)
    )
  ) {
    return mismatch(
      "scopes do not resolve to one verified worktree of the run repository"
    );
  }
  const workspace = {
    ...(executionCwd ? { executionCwd } : {}),
    ...(request.executionOutput
      ? { executionOutput: request.executionOutput }
      : {}),
    ...(executionPlan ? { executionPlan } : {}),
    ...(request.executionRead && executionReadPath
      ? {
          executionRead: {
            ...request.executionRead,
            path: executionReadPath,
          },
        }
      : {}),
    readScope,
    root: selectedRoot,
    writeScope,
  };
  return {
    request: {
      ...request,
      ...(executionCwd ? { executionCwd } : {}),
      ...(request.executionRead && executionReadPath
        ? {
            executionRead: {
              ...request.executionRead,
              path: executionReadPath,
            },
          }
        : {}),
      ...(executionPlan ? { executionPlan } : {}),
      readScope,
      writeScope,
    },
    workspace,
  };
};

export const verifyAdoptedUtilityWorkspace = (
  runRoot: string,
  workspace: UtilityResolvedWorkspace
): UtilityResolvedWorkspace | undefined => {
  let canonicalRunRoot: string;
  let canonicalWorkspaceRoot: string;
  try {
    canonicalRunRoot = realpathSync(runRoot);
    canonicalWorkspaceRoot = realpathSync(workspace.root);
  } catch {
    return undefined;
  }
  if (canonicalRunRoot === canonicalWorkspaceRoot) {
    return { ...workspace, root: canonicalWorkspaceRoot };
  }
  const runIdentity = gitWorkspaceIdentity(canonicalRunRoot);
  const workspaceIdentity = gitWorkspaceIdentity(canonicalWorkspaceRoot);
  const registeredRoots = registeredWorktreeRoots(canonicalRunRoot);
  if (
    !(runIdentity && workspaceIdentity) ||
    runIdentity.commonDir !== workspaceIdentity.commonDir ||
    !registeredRoots?.has(canonicalWorkspaceRoot) ||
    workspaceIdentity.root !== canonicalWorkspaceRoot
  ) {
    return undefined;
  }
  return { ...workspace, root: canonicalWorkspaceRoot };
};
