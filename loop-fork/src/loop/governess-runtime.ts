import type { Agent } from "./types";

export type GovernessAgentState =
  | "starting"
  | "working"
  | "input-required"
  | "waiting-peer"
  | "blocked"
  | "draining"
  | "handover-ready"
  | "exited"
  | "failed"
  | "canceled"
  | "unknown";

export interface GovernessLifecycleEvent {
  agent: Agent;
  at: string;
  epoch: number;
  evidence?: string;
  sequence: number;
  state: GovernessAgentState;
}

export interface GovernessCheckpoint {
  agent: Agent;
  at: string;
  reference: string;
}

export interface GovernessControlEnvelope {
  action: "message" | "drain" | "exit";
  controlId: string;
  epoch: number;
  message: string;
  target: Agent;
}

export interface GovernessRuntimeObservation {
  alive: boolean;
  evidence: string;
  state: GovernessAgentState;
}

export interface GovernessRuntimeAdapter {
  agent: Agent;
  checkpoint: () => Promise<GovernessCheckpoint | undefined>;
  observe: () => Promise<GovernessRuntimeObservation>;
  requestDrain: (control: GovernessControlEnvelope) => Promise<string>;
  requestExit: (control: GovernessControlEnvelope) => Promise<string>;
  sendControl: (control: GovernessControlEnvelope) => Promise<string>;
}

export interface GovernessDriverLease {
  epoch: number;
  expiresAt: string;
  holder: Agent;
}

export const driverLeaseIsCurrent = (
  lease: GovernessDriverLease | undefined,
  epoch: number | undefined,
  nowMs: number
): boolean =>
  typeof epoch === "number" &&
  lease?.epoch === epoch &&
  Date.parse(lease.expiresAt) >= nowMs;

export const explicitAgentState = (
  displayState: string | undefined,
  alive: boolean
): GovernessAgentState => {
  if (!alive) {
    return "exited";
  }
  switch (displayState) {
    case "working":
    case "thinking":
      return "working";
    case "waiting-human":
      return "input-required";
    case "waiting-peer":
      return "waiting-peer";
    case "limited":
    case "stuck":
      return "blocked";
    case "crashed":
      return "failed";
    case "idle":
      return "input-required";
    default:
      return "unknown";
  }
};

export const nextLifecycleEvent = (
  previous: GovernessLifecycleEvent | undefined,
  input: Omit<GovernessLifecycleEvent, "sequence">
): GovernessLifecycleEvent => ({
  ...input,
  sequence: (previous?.sequence ?? 0) + 1,
});
