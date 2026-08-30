import { lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  SupervisorBridgeDirectory,
  SupervisorBridgeRoute,
} from "./bridge-supervisor-message-delivery";
import { isActiveRunState, readRunManifest } from "./run-state";

export interface LoopSupervisorBinding {
  manifestPath: string;
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

  constructor(bindings: readonly LoopSupervisorBinding[]) {
    for (const binding of bindings) {
      if (!SUPERVISOR_ID_RE.test(binding.supervisorId)) {
        throw new Error("supervisor binding identity is invalid");
      }
      if (this.#manifests.has(binding.supervisorId)) {
        throw new Error(`duplicate supervisor binding ${binding.supervisorId}`);
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
    return { runDir, target: "supervisor" };
  }
}
