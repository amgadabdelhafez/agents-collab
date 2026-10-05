import { lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { isAgent } from "./agents";
import type {
  SupervisorBridgeDirectory,
  SupervisorBridgeRoute,
} from "./bridge-supervisor-message-delivery";
import { isActiveRunState, readRunManifest } from "./run-state";

export interface LoopSupervisorBinding {
  // Absent for a recipient that is not a Loop run. Such a recipient has no pane
  // to wake, so it never routes over the bridge and delivery falls through to
  // its mailbox, which is durable but polling-only.
  manifestPath?: string;
  /** Explicit enrolled seat. Omitted retains the legacy primary-agent route. */
  seat?: "claude" | "codex";
  supervisorId: string;
}

const SUPERVISOR_ID_RE = /^supervisor:[a-z0-9][a-z0-9._-]{0,127}$/;

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

export class LoopSupervisorDirectory implements SupervisorBridgeDirectory {
  readonly #manifests = new Map<string, string>();
  readonly #seats = new Map<string, "claude" | "codex">();

  constructor(bindings: readonly LoopSupervisorBinding[]) {
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
      this.#manifests.set(
        binding.supervisorId,
        exactManifest(binding.manifestPath)
      );
    }
    if (this.#manifests.size === 0) {
      throw new Error("at least one supervisor binding is required");
    }
  }

  resolve(supervisorId: string): SupervisorBridgeRoute | undefined {
    // "" is a registered recipient with no run: unroutable over the bridge,
    // which is the same answer as unknown for routing purposes.
    const manifestPath = this.#manifests.get(supervisorId);
    if (!manifestPath) {
      return undefined;
    }
    const manifest = readRunManifest(manifestPath);
    if (!(manifest && isActiveRunState(manifest.state))) {
      return undefined;
    }
    const runDir = dirname(manifestPath);
    if (realpathSync(join(runDir, "manifest.json")) !== manifestPath) {
      throw new Error("supervisor run manifest identity changed");
    }
    const target =
      this.#seats.get(supervisorId) ??
      (isAgent(manifest.primaryAgent) ? manifest.primaryAgent : undefined);
    const declaredAgents = new Set(
      [manifest.tmuxPaneLeftAgent, manifest.tmuxPaneRightAgent].filter(isAgent)
    );
    if (!(target && declaredAgents.has(target))) {
      return undefined;
    }
    return { runDir, target };
  }
}
