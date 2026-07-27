export type GovernessActionClass =
  | "observe"
  | "safe-automatic"
  | "require-confirmation"
  | "forbidden";

export type GovernessAction =
  | "observe-runtime"
  | "render"
  | "summarize"
  | "label-pane"
  | "send-control"
  | "answer-prompt"
  | "nudge"
  | "change-driver"
  | "restart-agent"
  | "handover-loop"
  | "teardown-loop"
  | "commit"
  | "push"
  | "merge"
  | "deploy"
  | "discard-work";

export interface GovernessPolicyContext {
  confirmed?: boolean;
  deterministicReason?: boolean;
  fenceCurrent: boolean;
  targetSafe?: boolean;
}

export interface GovernessPolicyDecision {
  action: GovernessAction;
  allowed: boolean;
  class: GovernessActionClass;
  reason: string;
}

const OBSERVE_ACTIONS = new Set<GovernessAction>([
  "observe-runtime",
  "render",
  "summarize",
  "label-pane",
]);

const FORBIDDEN_ACTIONS = new Set<GovernessAction>([
  "commit",
  "push",
  "merge",
  "deploy",
  "discard-work",
]);

const CONFIRMED_ACTIONS = new Set<GovernessAction>([
  "restart-agent",
  "handover-loop",
  "teardown-loop",
]);

export const decideGovernessPolicy = (
  action: GovernessAction,
  context: GovernessPolicyContext
): GovernessPolicyDecision => {
  if (OBSERVE_ACTIONS.has(action)) {
    return { action, allowed: true, class: "observe", reason: "read-only" };
  }
  if (FORBIDDEN_ACTIONS.has(action)) {
    return {
      action,
      allowed: false,
      class: "forbidden",
      reason: "outside governess authority",
    };
  }
  if (!context.fenceCurrent) {
    return {
      action,
      allowed: false,
      class: "safe-automatic",
      reason: "stale governess epoch",
    };
  }
  if (CONFIRMED_ACTIONS.has(action)) {
    return {
      action,
      allowed: context.confirmed === true,
      class: "require-confirmation",
      reason: context.confirmed ? "human confirmed" : "confirmation required",
    };
  }
  if (action === "change-driver") {
    return {
      action,
      allowed: context.deterministicReason === true,
      class: "safe-automatic",
      reason: context.deterministicReason
        ? "deterministic quota policy"
        : "non-deterministic role change",
    };
  }
  const targetSafe = context.targetSafe === true;
  return {
    action,
    allowed: targetSafe,
    class: "safe-automatic",
    reason: targetSafe ? "target is safe" : "target readiness is uncertain",
  };
};
