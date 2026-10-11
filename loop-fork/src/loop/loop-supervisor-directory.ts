import { lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { isAgent } from "./agents";
import type {
  SupervisorBridgeDirectory,
  SupervisorBridgeRoute,
} from "./bridge-supervisor-message-delivery";
import { isActiveRunState, readRunManifest } from "./run-state";
import type { ResolvedSupervisorEndpointOf } from "./supervisor-endpoint-lease";
import { SUPERVISOR_ID_RE } from "./supervisor-id";

export interface LoopSupervisorBinding {
  // Absent for a recipient that is not a Loop run. Such a recipient has no pane
  // to wake, so it never routes over the bridge and delivery falls through to
  // its mailbox, which is durable but polling-only.
  manifestPath?: string;
  /** Explicit enrolled seat. Omitted retains the legacy primary-agent route. */
  seat?: "claude" | "codex";
  supervisorId: string;
}

const exactManifest = (manifestPath: string): string => {
  const stat = lstatSync(manifestPath);
  if (!(stat.isFile() && !stat.isSymbolicLink())) {
    throw new Error("supervisor manifest must be a regular non-symlink file");
  }
  const resolved = realpathSync(manifestPath);
  if (resolved !== manifestPath) {
    throw new Error("supervisor manifest path must be canonical");
  }
  return resolved;
};

const isMissing = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

export interface LoopSupervisorDirectoryOptions {
  /**
   * Whether a binding's manifest and run directory may be read synchronously
   * now. The orchestration server answers it from an async, bounded probe
   * (a path under ~/Documents can park any open behind a macOS privacy
   * prompt, and a parked synchronous read freezes the whole server). A
   * binding not cleared is checked neither at construction nor on resolve:
   * it routes nowhere, as a stopped run does, until it is cleared. Absent:
   * every binding may be read (the CLI and tests).
   */
  mayAccess?: (supervisorId: string) => boolean;
}

export class LoopSupervisorDirectory implements SupervisorBridgeDirectory {
  readonly #mayAccess: (supervisorId: string) => boolean;
  readonly #manifests = new Map<string, string>();
  /**
   * fix8: bindings whose manifest did not exist when the directory was built
   * (a run directory removed, a run not started yet). Such a binding routes
   * nowhere, as a stopped run does, until its manifest exists; it is then
   * checked as at construction (regular, non-symlink, canonical). A missing
   * manifest is runtime state, not a configuration error, so it never refuses
   * a server start.
   */
  readonly #unverified = new Set<string>();
  readonly #seats = new Map<string, "claude" | "codex">();

  constructor(
    bindings: readonly LoopSupervisorBinding[],
    options: LoopSupervisorDirectoryOptions = {}
  ) {
    this.#mayAccess = options.mayAccess ?? (() => true);
    for (const binding of bindings) {
      if (binding.seat !== undefined) {
        if (binding.seat !== "claude" && binding.seat !== "codex") {
          throw new Error("supervisor seat is invalid");
        }
        this.#seats.set(binding.supervisorId, binding.seat);
      }
      if (!SUPERVISOR_ID_RE.test(binding.supervisorId)) {
        throw new Error("supervisor binding identity is invalid");
      }
      if (this.#manifests.has(binding.supervisorId)) {
        throw new Error(`duplicate supervisor binding ${binding.supervisorId}`);
      }
      if (binding.manifestPath === undefined) {
        // Recorded as known-but-unroutable, so a duplicate id is still caught.
        this.#manifests.set(binding.supervisorId, "");
        continue;
      }
      this.#registerManifest(binding.supervisorId, binding.manifestPath);
    }
    if (this.#manifests.size === 0) {
      throw new Error("at least one supervisor binding is required");
    }
  }

  #registerManifest(supervisorId: string, manifestPath: string): void {
    if (!this.#mayAccess(supervisorId)) {
      // Checked on its first resolve after it is cleared, as a manifest that
      // did not exist yet is.
      this.#manifests.set(supervisorId, manifestPath);
      this.#unverified.add(supervisorId);
      return;
    }
    try {
      this.#manifests.set(supervisorId, exactManifest(manifestPath));
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      this.#manifests.set(supervisorId, manifestPath);
      this.#unverified.add(supervisorId);
    }
  }

  resolve(supervisorId: string): SupervisorBridgeRoute | undefined {
    // "" is a registered recipient with no run: unroutable over the bridge,
    // which is the same answer as unknown for routing purposes.
    const manifestPath = this.#manifests.get(supervisorId);
    if (!(manifestPath && this.#mayAccess(supervisorId))) {
      return undefined;
    }
    if (this.#unverified.has(supervisorId)) {
      try {
        exactManifest(manifestPath);
      } catch (error) {
        if (isMissing(error)) {
          return undefined;
        }
        throw error;
      }
      this.#unverified.delete(supervisorId);
    }
    return activeRunSeatRoute(manifestPath, this.#seats.get(supervisorId));
  }
}

/**
 * The bridge route of an active run's seat: the run must be in an active
 * state, its manifest must still be the one named, and the seat (or, when
 * none is given, the run's primary agent) must be one of its declared panes.
 * Shared by the manifest-bound directory and the r9 lease-backed Loop run
 * endpoint, so both refuse the same stopped or undeclared seats.
 */
const activeRunSeatRoute = (
  manifestPath: string,
  seat: "claude" | "codex" | undefined
): SupervisorBridgeRoute | undefined => {
  const manifest = readRunManifest(manifestPath);
  if (!(manifest && isActiveRunState(manifest.state))) {
    return undefined;
  }
  const runDir = dirname(manifestPath);
  if (realpathSync(join(runDir, "manifest.json")) !== manifestPath) {
    throw new Error("supervisor run manifest identity changed");
  }
  const target =
    seat ??
    (isAgent(manifest.primaryAgent) ? manifest.primaryAgent : undefined);
  const declaredAgents = new Set(
    [manifest.tmuxPaneLeftAgent, manifest.tmuxPaneRightAgent].filter(isAgent)
  );
  if (!(target && declaredAgents.has(target))) {
    return undefined;
  }
  return { runDir, target };
};

/**
 * r9: the bridge route of a Loop run endpoint the server just resolved from a
 * lease (`resolveSupervisorEndpointLocator`, which derived and
 * realpath-checked runDir and manifestPath under its own runs root). Never
 * takes a locator or a caller path. Undefined, never a throw, when the run is
 * not active, the seat is not a declared pane, or the run directory no longer
 * holds that manifest: the endpoint is simply not ready.
 */
export const loopRunEndpointRoute = (
  endpoint: ResolvedSupervisorEndpointOf<"loop-run">
): SupervisorBridgeRoute | undefined => {
  let route: SupervisorBridgeRoute | undefined;
  try {
    route = activeRunSeatRoute(endpoint.manifestPath, endpoint.seat);
  } catch {
    return undefined;
  }
  if (!route || route.runDir !== endpoint.runDir) {
    return undefined;
  }
  return route;
};
