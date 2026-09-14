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

// Publishing a public ask is part of waiting for a human, not work. Its own
// tool hooks must not open a new episode, or the ask is stale on arrival.
const PUBLIC_ASK_TOOL_SUFFIX = "__publish_human_ask";

const hookState = (event: HookEvent): GovernessAgentState | undefined => {
  if (
    (event.event === "PreToolUse" || event.event === "PostToolUse") &&
    event.tool?.endsWith(PUBLIC_ASK_TOOL_SUFFIX)
  ) {
    return undefined;
  }
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
    // Sequences of this agent's open public asks in this epoch.
    openAskSequences?: ReadonlySet<number>;
  }
): GovernessLifecycleEvent | undefined => {
  const hooked = input.hooks.filter((event) => hookState(event) !== undefined);
  const last = hooked.at(-1);
  const seen =
    previous?.epoch === input.epoch ? previous.sourceSequence : undefined;
  // Fold every hook since the last one this episode chain consumed. Sampling
  // only the newest hook per tick made the sequence depend on tick timing: a
  // turn that started and stopped between two ticks was never counted, so a
  // producer could not know which episode would end its turn and a public
  // ask bound to the wrong one (observed: ask bound to 2, idle episode 4).
  if (
    last &&
    seen !== undefined &&
    last.sequence !== undefined &&
    last.sequence >= seen
  ) {
    let event = previous;
    for (const hook of hooked) {
      if (hook.sequence !== undefined && hook.sequence > seen) {
        event = lifecycleEventFromHook(event, input, hook);
      }
    }
    return event;
  }
  return lifecycleEventFromHook(previous, input, last);
};

const lifecycleEventFromHook = (
  previous: GovernessLifecycleEvent | undefined,
  input: {
    agent: Agent;
    at: string;
    epoch: number;
    fallback: GovernessRuntimeObservation;
    openAskSequences?: ReadonlySet<number>;
  },
  hook: HookEvent | undefined
): GovernessLifecycleEvent | undefined => {
  const state = hook ? hookState(hook) : input.fallback.state;
  if (!state) {
    return previous;
  }
  const sourceSequence = hook?.sequence;
  const evidence = hook
    ? `${hook.event}:${hook.eventId ?? hook.sequence ?? hook.ts}`
    : input.fallback.evidence;
  const source = hook?.source ?? "tmux-fallback";
  // An episode is a lifecycle state, not a hook event. Repeated evidence for
  // the same state (a Stop after a tool call, Claude's idle Notification)
  // used to open a new episode each time, which re-keyed the interaction id
  // every minute and made any published ask stale as soon as the agent
  // stopped, so no answer could ever be routed.
  if (previous?.epoch === input.epoch && previous.state === state) {
    return previous;
  }
  // An agent waiting on its own open public ask polls for the answer, and each
  // poll is a working turn ending in Stop. Those turns are part of waiting, so
  // they keep the ask's episode (consuming the hooks) until the ask resolves
  // or the agent reaches any state other than working or input-required.
  if (
    previous?.epoch === input.epoch &&
    previous.state === "input-required" &&
    (state === "working" || state === "input-required") &&
    input.openAskSequences?.has(previous.sequence)
  ) {
    return sourceSequence !== undefined &&
      sourceSequence > (previous.sourceSequence ?? 0)
      ? { ...previous, sourceSequence }
      : previous;
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
