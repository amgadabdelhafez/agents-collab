// Release authority is a property of governing policy rather than of seat
// occupancy. An advisory reviewer's approval never opens the release gate on
// its own.
import type { Agent } from "./types";

export const RELEASE_AUTHORITY_ENV = "LOOP_OSS_RELEASE_AUTHORITY";

export interface ReleaseAuthorityPolicy {
  ossReleaseAuthority: boolean;
}

export const resolveReleaseAuthorityPolicy = (
  env: NodeJS.ProcessEnv
): ReleaseAuthorityPolicy => ({
  ossReleaseAuthority: env[RELEASE_AUTHORITY_ENV]?.trim() === "1",
});

export const reviewerHasReleaseAuthority = (
  reviewer: Agent,
  policy: ReleaseAuthorityPolicy
): boolean => {
  switch (reviewer) {
    case "claude":
      return true;
    case "codex":
      return true;
    case "oss":
      return policy.ossReleaseAuthority;
    default: {
      const exhaustive: never = reviewer;
      throw new Error(`Unknown reviewer: ${exhaustive}`);
    }
  }
};

export const ADVISORY_REVIEWER_NOTE =
  "[loop] advisory reviewer approval does not open the release gate; no model gains release authority merely by occupying a seat.";
