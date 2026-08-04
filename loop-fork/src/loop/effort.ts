import type { EffortLevel } from "./types";

export const EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly EffortLevel[];

export const DEFAULT_LAUNCH_EFFORT: EffortLevel = "medium";

export const isEffortLevel = (value: string): value is EffortLevel =>
  (EFFORT_LEVELS as readonly string[]).includes(value);

export const parseEffortLevel = (
  value: string,
  source: string
): EffortLevel => {
  const normalized = value.trim().toLowerCase();
  if (isEffortLevel(normalized)) {
    return normalized;
  }
  throw new Error(
    `Invalid ${source} value: ${value}; expected ${EFFORT_LEVELS.join(", ")}`
  );
};
