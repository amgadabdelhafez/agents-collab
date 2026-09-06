import type { EffortLevel } from "./types";

export const EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly EffortLevel[];

export const DEFAULT_LAUNCH_EFFORT: EffortLevel = "medium";

// The two seats want opposite settings. The driver writes code the reviewer
// then reads: cheap, fast passes from the driver and a thorough read from the
// reviewer beats both seats grinding at the same middle setting. `--effort`
// still sets both at once, and either role can be pinned on its own.
export const DEFAULT_DRIVER_EFFORT: EffortLevel = "low";
export const DEFAULT_REVIEWER_EFFORT: EffortLevel = "high";

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
