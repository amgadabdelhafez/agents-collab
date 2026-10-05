import { createHash } from "node:crypto";
import { readBridgeStatus } from "./bridge-store";
import type { SupervisorBridgeDirectory } from "./bridge-supervisor-message-delivery";
import { probeClaudeChannelReadiness } from "./claude-channel-readiness";
import { probeCodexThread } from "./codex-app-server";
import type {
  SupervisorSessionDescriptorV2,
  SupervisorSessionProviderReadinessPort,
} from "./supervisor-session-v2";

/**
 * A no-turn readiness adapter for the one provider whose current session has
 * an existing supported read/resume probe. It does not discover a thread,
 * inject a message, or treat a healthy app-server as receipt consumption.
 */
export class LoopCodexSessionV2ProviderReadiness
  implements SupervisorSessionProviderReadinessPort
{
  readonly #directory: SupervisorBridgeDirectory;
  readonly #probe: typeof probeCodexThread;
  readonly #status: typeof readBridgeStatus;
  readonly #claudeProbe: typeof probeClaudeChannelReadiness;

  constructor(options: {
    directory: SupervisorBridgeDirectory;
    probe?: typeof probeCodexThread;
    status?: typeof readBridgeStatus;
    claudeProbe?: typeof probeClaudeChannelReadiness;
  }) {
    this.#directory = options.directory;
    this.#probe = options.probe ?? probeCodexThread;
    this.#status = options.status ?? readBridgeStatus;
    this.#claudeProbe = options.claudeProbe ?? probeClaudeChannelReadiness;
  }

  async ready(descriptor: SupervisorSessionDescriptorV2) {
    if (descriptor.provider === "claude-code") {
      const route = await this.#directory.resolve(descriptor.recipient);
      if (!route || route.target !== "claude") {
        throw new Error("configured recipient has no Claude route");
      }
      const status = this.#status(route.runDir);
      if (
        !(status.claudeSessionId && status.claudeChannelServer) ||
        descriptor.sessionRef !== `session:${status.claudeSessionId}` ||
        descriptor.endpointDigest !==
          createHash("sha256").update(status.claudeChannelServer).digest("hex")
      ) {
        throw new Error("configured Claude session identity changed");
      }
      if (!this.#claudeProbe(route.runDir)) {
        throw new Error("configured Claude channel is not ready");
      }
      return {
        descriptorId: descriptor.descriptorId,
        endpointDigest: descriptor.endpointDigest,
        provider: descriptor.provider,
        revision: descriptor.revision,
        sessionRef: descriptor.sessionRef,
        status: "ready" as const,
      };
    }
    if (descriptor.provider !== "codex-app-server") {
      throw new Error("configured provider does not support readiness");
    }
    const route = await this.#directory.resolve(descriptor.recipient);
    if (!route || route.target !== "codex") {
      throw new Error("configured recipient has no Codex route");
    }
    const status = this.#status(route.runDir);
    if (!(status.codexRemoteUrl && status.codexThreadId)) {
      throw new Error("configured Codex session is unavailable");
    }
    const endpointDigest = createHash("sha256")
      .update(status.codexRemoteUrl)
      .digest("hex");
    if (
      descriptor.endpointDigest !== endpointDigest ||
      descriptor.sessionRef !== `session:${status.codexThreadId}`
    ) {
      throw new Error("configured Codex session identity changed");
    }
    if (!(await this.#probe(status.codexRemoteUrl, status.codexThreadId))) {
      throw new Error("configured Codex session is not ready");
    }
    return {
      descriptorId: descriptor.descriptorId,
      endpointDigest: descriptor.endpointDigest,
      provider: descriptor.provider,
      revision: descriptor.revision,
      sessionRef: descriptor.sessionRef,
      status: "ready" as const,
    };
  }
}
