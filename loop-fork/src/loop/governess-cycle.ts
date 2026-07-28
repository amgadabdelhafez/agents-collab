import {
  decideGovernessControlReconciliation,
  type GovernessControlReconciliation,
  type GovernessControlRecord,
  governessHookEventReference,
} from "./governess-journal";
import type { GovernessLifecycleEvent } from "./governess-runtime";
import type { Agent, HookEvent } from "./types";

export interface GovernessObservationSnapshot {
  agents: Partial<Record<Agent, GovernessLifecycleEvent>>;
  at: string;
  controls: GovernessControlRecord[];
  epoch: number;
  holder?: Agent;
  hooks: Partial<Record<Agent, HookEvent[]>>;
  tick: number;
}

export type GovernessCycleDecision =
  | {
      holder: Agent;
      kind: "renew-driver-lease";
    }
  | ({ kind: "transition-control" } & GovernessControlReconciliation);

// This function is intentionally pure. Journal replay runs the exact same
// decision logic and can report behavior drift without repeating any effect.
export const decideGovernessCycle = (
  snapshot: GovernessObservationSnapshot
): GovernessCycleDecision[] => {
  const decisions: GovernessCycleDecision[] = [];
  if (snapshot.holder) {
    decisions.push({ holder: snapshot.holder, kind: "renew-driver-lease" });
  }
  for (const transition of decideGovernessControlReconciliation(
    snapshot.controls,
    snapshot.hooks
  )) {
    decisions.push({ kind: "transition-control", ...transition });
  }
  return decisions;
};

// Replay only needs the hook events that caused transitions. Keeping those
// events, instead of the full session hook history, bounds every cycle record
// by the number of pending controls.
export const compactGovernessCycleSnapshot = (
  snapshot: GovernessObservationSnapshot,
  decisions: GovernessCycleDecision[]
): GovernessObservationSnapshot => {
  const evidence = new Set(
    decisions
      .filter((decision) => decision.kind === "transition-control")
      .map((decision) => decision.evidence)
  );
  const hooks: Partial<Record<Agent, HookEvent[]>> = {};
  for (const [agent, events] of Object.entries(snapshot.hooks) as [
    Agent,
    HookEvent[],
  ][]) {
    const retained = events.filter((event) =>
      evidence.has(governessHookEventReference(event))
    );
    if (retained.length > 0) {
      hooks[agent] = retained;
    }
  }
  return { ...snapshot, hooks };
};

export interface GovernessCycleExecutor {
  renewDriverLease: (holder: Agent) => void;
  transitionControl: (decision: GovernessControlReconciliation) => void;
}

// All effects cross one executor boundary after the snapshot has been taken
// and decisions have been computed. Callers perform epoch fencing before this.
export const executeGovernessCycle = (
  decisions: GovernessCycleDecision[],
  executor: GovernessCycleExecutor
): void => {
  for (const decision of decisions) {
    if (decision.kind === "renew-driver-lease") {
      executor.renewDriverLease(decision.holder);
    } else {
      executor.transitionControl(decision);
    }
  }
};
