import type { Agent, HookEvent } from "./types";

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
  source?: "agent-hook" | "codex-app-server" | "tmux-fallback";
  sourceSequence?: number;
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

const hookState = (event: HookEvent): GovernessAgentState | undefined => {
  if (event.state) {
    return event.state;
  }
  if (event.error) {
    return "failed";
  }
  switch (event.event) {
    case "SessionStart":
      return "starting";
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
      return "working";
    case "Notification":
    case "Stop":
      return "input-required";
    default:
      return undefined;
  }
};

export const lifecycleEventFromEvidence = (
  previous: GovernessLifecycleEvent | undefined,
  input: {
    agent: Agent;
    at: string;
    epoch: number;
    fallback: GovernessRuntimeObservation;
    hooks: HookEvent[];
  }
): GovernessLifecycleEvent | undefined => {
  const hook = input.hooks.findLast((event) => hookState(event) !== undefined);
  const state = hook ? hookState(hook) : input.fallback.state;
  if (!state) {
    return previous;
  }
  const sourceSequence = hook?.sequence;
  const evidence = hook
    ? `${hook.event}:${hook.eventId ?? hook.sequence ?? hook.ts}`
    : input.fallback.evidence;
  const source = hook?.source ?? "tmux-fallback";
  if (
    previous?.epoch === input.epoch &&
    previous.state === state &&
    previous.source === source &&
    previous.sourceSequence === sourceSequence &&
    previous.evidence === evidence
  ) {
    return previous;
  }
  return nextLifecycleEvent(previous, {
    agent: input.agent,
    at: hook?.ts ?? input.at,
    epoch: input.epoch,
    evidence,
    source,
    ...(sourceSequence === undefined ? {} : { sourceSequence }),
    state,
  });
};
