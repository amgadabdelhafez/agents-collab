import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { runGit } from "./git";
import {
  type UtilityResolvedWorkspace,
  type UtilityRouteRequest,
  utilityRequestTouchesProtectedPath,
} from "./task-router";
import { isUtilityProtectedPath } from "./utility-path-policy";

export interface UtilityWorkspaceResolution {
  request: UtilityRouteRequest;
  workspace?: UtilityResolvedWorkspace;
}

export interface UtilityWorkspaceFailure {
  detail: string;
  reason: "protected-scope" | "workspace-unverified";
}

const isContained = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === "" || !(rel.startsWith("..") || isAbsolute(rel));
};

const nearestExistingPath = (value: string): string | undefined => {
  let candidate = resolve(value);
  while (true) {
    try {
      lstatSync(candidate);
      return candidate;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return undefined;
      }
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      return undefined;
    }
    candidate = parent;
  }
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

const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:\//;
const EXPLICIT_ROOT_DETAIL =
  "workspace_root must name the exact canonical run root or an exact registered worktree of the run repository";
const EXPLICIT_PATH_DETAIL =
  "workspace_root requires every packet path to be repo-relative, symlink-free, and contained beneath the selected root";
const EXACT_EDIT_SCOPE_DETAIL =
  "edit scopes must name exact regular files under the selected workspace; relative scopes bind to the run root unless workspace_root selects a registered linked worktree";

const exactCanonicalDirectory = (path: string): string | undefined => {
  if (!isAbsolute(path) || resolve(path) !== path) {
    return undefined;
  }
  try {
    return lstatSync(path).isDirectory() && realpathSync(path) === path
      ? path
      : undefined;
  } catch {
    return undefined;
  }
};

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
    const registeredRoot = exactCanonicalDirectory(
      line.slice("worktree ".length).trim()
    );
    if (registeredRoot) {
      roots.add(registeredRoot);
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

const mismatch = (
  detail: string,
  reason: UtilityWorkspaceFailure["reason"] = "workspace-unverified"
): UtilityWorkspaceFailure => ({ detail, reason });

const focusedCheckPathStart = (argv: readonly string[]): number | undefined => {
  if (argv[0] === "bun" && argv[1] === "test") {
    return 2;
  }
  if (argv[0] === "npx" && argv[1] === "vitest" && argv[2] === "run") {
    return 3;
  }
  if (argv[0] === "node" && argv[1] === "--check") {
    return 2;
  }
  return undefined;
};

const resolveExplicitUtilityWorkspaceRoot = (
  runRoot: string,
  requestedRoot: string
): string | undefined => {
  if (requestedRoot.includes("\0") || !exactCanonicalDirectory(requestedRoot)) {
    return undefined;
  }
  if (requestedRoot === runRoot) {
    return runRoot;
  }
  const runIdentity = gitWorkspaceIdentity(runRoot);
  const requestedIdentity = gitWorkspaceIdentity(requestedRoot);
  const registeredRoots = registeredWorktreeRoots(runRoot);
  if (
    !(runIdentity && requestedIdentity) ||
    runIdentity.commonDir !== requestedIdentity.commonDir ||
    requestedIdentity.root !== requestedRoot ||
    !registeredRoots?.has(requestedRoot)
  ) {
    return undefined;
  }
  return requestedRoot;
};

const normalizeExplicitPacketPath = (
  root: string,
  value: string
): string | undefined => {
  if (
    !value ||
    isAbsolute(value) ||
    WINDOWS_ABSOLUTE_PATH_RE.test(value) ||
    value.includes("\0")
  ) {
    return undefined;
  }
  const target = resolve(root, value);
  if (!isContained(root, target)) {
    return undefined;
  }
  const canonical = canonicalTarget(target);
  if (!canonical || canonical !== target) {
    return undefined;
  }
  const scoped = relative(root, target).replaceAll("\\", "/");
  return scoped || ".";
};

const normalizeExplicitPacketPaths = (
  root: string,
  values: readonly string[]
): string[] | undefined => {
  const normalized: string[] = [];
  for (const value of values) {
    const path = normalizeExplicitPacketPath(root, value);
    if (path === undefined) {
      return undefined;
    }
    normalized.push(path);
  }
  return normalized;
};

const normalizeExplicitFocusedCheckArgv = (
  root: string,
  argv: readonly string[] | undefined
): string[] | undefined => {
  if (!argv) {
    return undefined;
  }
  const pathStart = focusedCheckPathStart(argv);
  if (pathStart === undefined) {
    return undefined;
  }
  const paths = normalizeExplicitPacketPaths(root, argv.slice(pathStart));
  return paths ? [...argv.slice(0, pathStart), ...paths] : undefined;
};

const explicitPathFailureReason = (
  request: UtilityRouteRequest,
  root: string
): UtilityWorkspaceFailure["reason"] => {
  const paths = [
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
  const protectedPath = paths.some((path) => {
    if (
      !path ||
      isAbsolute(path) ||
      WINDOWS_ABSOLUTE_PATH_RE.test(path) ||
      path.includes("\0")
    ) {
      return false;
    }
    const target = resolve(root, path);
    if (!isContained(root, target)) {
      return false;
    }
    if (isUtilityProtectedPath(path)) {
      return true;
    }
    const canonical = canonicalTarget(target);
    if (!(canonical && isContained(root, canonical))) {
      return false;
    }
    const canonicalScope = relative(root, canonical).replaceAll("\\", "/");
    return isUtilityProtectedPath(canonicalScope || ".");
  });
  return protectedPath ? "protected-scope" : "workspace-unverified";
};

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
    ...(request.executionArgv
      ? { executionArgv: [...request.executionArgv] }
      : {}),
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

const exactEditFileScope = (
  root: string,
  scope: string,
  allowMissing: boolean
): boolean => {
  const target = resolve(root, scope);
  if (!isContained(root, target)) {
    return false;
  }
  try {
    return lstatSync(target).isFile() && realpathSync(target) === target;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      return false;
    }
  }
  if (!allowMissing) {
    return false;
  }
  const existing = nearestExistingPath(target);
  if (!(existing && isContained(root, existing))) {
    return false;
  }
  try {
    return (
      realpathSync(existing) === existing && lstatSync(existing).isDirectory()
    );
  } catch {
    return false;
  }
};

const validateExactEditScopes = (
  resolution: UtilityWorkspaceResolution
): UtilityWorkspaceResolution | UtilityWorkspaceFailure => {
  if (resolution.request.kind !== "edit" || !resolution.workspace) {
    return resolution;
  }
  const root = resolution.workspace.root;
  const writeScopes = new Set(resolution.request.writeScope);
  const validWriteScopes = resolution.request.writeScope.every((scope) =>
    exactEditFileScope(root, scope, true)
  );
  const validReadScopes = resolution.request.readScope.every((scope) =>
    exactEditFileScope(root, scope, writeScopes.has(scope))
  );
  return validWriteScopes && validReadScopes
    ? resolution
    : mismatch(
        EXACT_EDIT_SCOPE_DETAIL,
        utilityRequestTouchesProtectedPath(resolution.request)
          ? "protected-scope"
          : "workspace-unverified"
      );
};

const explicitWorkspaceResolution = (
  request: UtilityRouteRequest,
  root: string
): UtilityWorkspaceResolution | UtilityWorkspaceFailure => {
  const readScope = normalizeExplicitPacketPaths(root, request.readScope);
  const writeScope = normalizeExplicitPacketPaths(root, request.writeScope);
  const executionCwd = request.executionCwd
    ? normalizeExplicitPacketPath(root, request.executionCwd)
    : undefined;
  const executionArgv =
    request.executionProfile === "focused-check"
      ? normalizeExplicitFocusedCheckArgv(root, request.executionArgv)
      : request.executionArgv;
  const executionReadPath = request.executionRead
    ? normalizeExplicitPacketPath(root, request.executionRead.path)
    : undefined;
  let executionPlan = request.executionPlan;
  let executionPlanIsValid = true;
  if (request.executionPlan) {
    executionPlan = [];
    for (const step of request.executionPlan) {
      const stepReadScope = normalizeExplicitPacketPaths(root, step.readScope);
      const stepExecutionCwd = step.executionCwd
        ? normalizeExplicitPacketPath(root, step.executionCwd)
        : undefined;
      const stepExecutionArgv =
        step.executionProfile === "focused-check"
          ? normalizeExplicitFocusedCheckArgv(root, step.executionArgv)
          : step.executionArgv;
      const stepExecutionReadPath = step.executionRead
        ? normalizeExplicitPacketPath(root, step.executionRead.path)
        : undefined;
      if (
        !stepReadScope ||
        (step.executionArgv !== undefined && !stepExecutionArgv) ||
        (step.executionCwd !== undefined && !stepExecutionCwd) ||
        (step.executionRead !== undefined && !stepExecutionReadPath)
      ) {
        executionPlanIsValid = false;
        break;
      }
      executionPlan.push({
        ...step,
        ...(stepExecutionArgv ? { executionArgv: stepExecutionArgv } : {}),
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
      executionPlanIsValid &&
      (request.executionArgv === undefined || executionArgv) &&
      (request.executionCwd === undefined || executionCwd) &&
      (request.executionRead === undefined || executionReadPath)
    )
  ) {
    return mismatch(
      EXPLICIT_PATH_DETAIL,
      explicitPathFailureReason(request, root)
    );
  }
  const normalizedRequest: UtilityRouteRequest = {
    ...request,
    ...(executionArgv ? { executionArgv } : {}),
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
  };
  return validateExactEditScopes(
    relativeWorkspaceResolution(normalizedRequest, root)
  );
};

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
  if (request.workspaceRoot !== undefined) {
    const explicitRoot = resolveExplicitUtilityWorkspaceRoot(
      canonicalRunRoot,
      request.workspaceRoot
    );
    return explicitRoot
      ? explicitWorkspaceResolution(request, explicitRoot)
      : mismatch(EXPLICIT_ROOT_DETAIL);
  }
  if (scopes.every((scope) => !isAbsolute(scope))) {
    return validateExactEditScopes(
      relativeWorkspaceResolution(request, canonicalRunRoot)
    );
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

  const normalizeFocusedCheckArgv = (
    argv: readonly string[] | undefined
  ): string[] | undefined => {
    if (!argv) {
      return undefined;
    }
    const pathStart = focusedCheckPathStart(argv);
    if (pathStart === undefined) {
      return undefined;
    }
    const paths = normalizeScopes(argv.slice(pathStart));
    return paths ? [...argv.slice(0, pathStart), ...paths] : undefined;
  };

  const readScope = normalizeScopes(request.readScope);
  const writeScope = normalizeScopes(request.writeScope);
  const executionCwd = request.executionCwd
    ? normalizeScopes([request.executionCwd])?.[0]
    : undefined;
  const executionArgv =
    request.executionProfile === "focused-check"
      ? normalizeFocusedCheckArgv(request.executionArgv)
      : request.executionArgv;
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
      const stepExecutionArgv =
        step.executionProfile === "focused-check"
          ? normalizeFocusedCheckArgv(step.executionArgv)
          : step.executionArgv;
      const stepExecutionReadPath = step.executionRead
        ? normalizeScopes([step.executionRead.path])?.[0]
        : undefined;
      if (
        !stepReadScope ||
        (step.executionArgv !== undefined && !stepExecutionArgv) ||
        (step.executionCwd !== undefined && !stepExecutionCwd) ||
        (step.executionRead !== undefined && !stepExecutionReadPath)
      ) {
        executionPlanIsValid = false;
        break;
      }
      executionPlan.push({
        ...step,
        ...(stepExecutionArgv ? { executionArgv: stepExecutionArgv } : {}),
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
      (request.executionArgv === undefined || executionArgv) &&
      (request.executionCwd === undefined || executionCwd) &&
      (request.executionRead === undefined || executionReadPath)
    )
  ) {
    return mismatch(
      "scopes do not resolve to one verified worktree of the run repository"
    );
  }
  const workspace = {
    ...(executionArgv ? { executionArgv } : {}),
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
  return validateExactEditScopes({
    request: {
      ...request,
      ...(executionArgv ? { executionArgv } : {}),
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
  });
};

export const verifyAdoptedUtilityWorkspace = (
  runRoot: string,
  workspace: UtilityResolvedWorkspace
): UtilityResolvedWorkspace | undefined => {
  let canonicalRunRoot: string;
  try {
    canonicalRunRoot = realpathSync(runRoot);
  } catch {
    return undefined;
  }
  if (!exactCanonicalDirectory(workspace.root)) {
    return undefined;
  }
  if (canonicalRunRoot === workspace.root) {
    return { ...workspace, root: workspace.root };
  }
  const runIdentity = gitWorkspaceIdentity(canonicalRunRoot);
  const workspaceIdentity = gitWorkspaceIdentity(workspace.root);
  const registeredRoots = registeredWorktreeRoots(canonicalRunRoot);
  if (
    !(runIdentity && workspaceIdentity) ||
    runIdentity.commonDir !== workspaceIdentity.commonDir ||
    !registeredRoots?.has(workspace.root) ||
    workspaceIdentity.root !== workspace.root
  ) {
    return undefined;
  }
  return { ...workspace, root: workspace.root };
};
