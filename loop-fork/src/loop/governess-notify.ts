import type { Agent } from "./types";

// A single thing the governess wants to reach the human about. Kept small and
// channel-agnostic so the transport (ntfy today, Telegram/Slack later) can vary.
export interface EscalationEvent {
  agent?: Agent;
  kind: "waiting-human" | "recovery-exhausted" | "budget";
  message: string;
  priority: "default" | "high" | "urgent";
  title: string;
}

const NTFY_TIMEOUT_MS = 8000;

const TAGS: Record<EscalationEvent["kind"], string> = {
  "waiting-human": "hourglass",
  "recovery-exhausted": "warning",
  budget: "moneybag",
};

// Push an escalation to an ntfy topic URL (e.g. https://ntfy.sh/my-topic, or a
// self-hosted server). Best-effort and fire-and-forget: never throws into the
// control loop. No-op when no topic URL is configured.
export const sendNtfy = (
  topicUrl: string | undefined,
  event: EscalationEvent
): void => {
  if (!topicUrl) {
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NTFY_TIMEOUT_MS);
  fetch(topicUrl, {
    body: event.message,
    headers: {
      Priority: event.priority,
      Tags: TAGS[event.kind],
      Title: event.title,
    },
    method: "POST",
    signal: controller.signal,
  })
    .catch(() => {
      // Escalation is best-effort; a down notifier must not break the loop.
    })
    .finally(() => clearTimeout(timer));
};
