import { describe, expect, test } from "bun:test";
import { fixtureRuns } from "../../src/webui/fixtures";
import {
  filterAndGroupRuns,
  getPrimaryRunGroup,
} from "../../src/webui/selectors";
import type { FleetRunDTO } from "../../src/webui/types";

const run = (runId: string): FleetRunDTO => {
  const match = fixtureRuns.find((candidate) => candidate.runId === runId);
  if (!match) {
    throw new Error(`Missing fixture run ${runId}`);
  }
  return match;
};

const idsByGroup = (
  groups: ReturnType<typeof filterAndGroupRuns>,
  key: (typeof groups)[number]["key"]
): readonly string[] =>
  groups.find((group) => group.key === key)?.runs.map((item) => item.runId) ??
  [];

describe("Web UI fleet selectors", () => {
  test("applies the exclusive group precedence", () => {
    expect(getPrimaryRunGroup(run("relay-214"))).toBe("needs-attention");
    expect(getPrimaryRunGroup(run("sentinel-042"))).toBe("needs-attention");
    expect(getPrimaryRunGroup(run("atlas-088"))).toBe("cleanup-debt");
    expect(getPrimaryRunGroup(run("ridge-301"))).toBe("active");
    expect(getPrimaryRunGroup(run("orbit-120"))).toBe("finished");

    const groups = filterAndGroupRuns(fixtureRuns);
    expect(groups.map((group) => group.key)).toEqual([
      "needs-attention",
      "cleanup-debt",
      "active",
      "finished",
    ]);
    expect(groups.flatMap((group) => group.runs)).toHaveLength(
      fixtureRuns.length
    );
    expect(
      new Set(groups.flatMap((group) => group.runs.map((item) => item.runId)))
        .size
    ).toBe(fixtureRuns.length);
  });

  test("searches useful row and reason fields without case sensitivity", () => {
    const byReason = filterAndGroupRuns(fixtureRuns, {
      query: "ACKNOWLEDGEMENT FAILED",
    });
    expect(idsByGroup(byReason, "needs-attention")).toEqual(["sentinel-042"]);

    const byWorktree = filterAndGroupRuns(fixtureRuns, {
      query: "cache-boundary",
    });
    expect(idsByGroup(byWorktree, "active")).toEqual(["ridge-298"]);
  });

  test("combines repository, lifecycle, and primary-group filters", () => {
    const ridgeReview = filterAndGroupRuns(fixtureRuns, {
      repository: "northstar/ridge",
      lifecycle: ["reviewing", "working"],
      group: "active",
    });

    expect(idsByGroup(ridgeReview, "active")).toEqual([
      "ridge-298",
      "ridge-301",
    ]);
    expect(ridgeReview.filter((group) => group.key !== "active")).toSatisfy(
      (groups) => groups.every((group) => group.runs.length === 0)
    );
  });

  test("sorts by severity, recent event, repository, and run id deterministically", () => {
    const attention = filterAndGroupRuns([
      run("relay-214"),
      run("sentinel-042"),
    ]);
    expect(idsByGroup(attention, "needs-attention")).toEqual([
      "sentinel-042",
      "relay-214",
    ]);

    const base = run("orbit-120");
    const sameTimeB: FleetRunDTO = {
      ...base,
      runId: "stable-b",
      repository: "paperkite/same",
    };
    const sameTimeA: FleetRunDTO = {
      ...base,
      runId: "stable-a",
      repository: "paperkite/same",
    };

    const forward = filterAndGroupRuns([sameTimeB, sameTimeA]);
    const reverse = filterAndGroupRuns([sameTimeA, sameTimeB]);
    expect(idsByGroup(forward, "finished")).toEqual(["stable-a", "stable-b"]);
    expect(idsByGroup(reverse, "finished")).toEqual(["stable-a", "stable-b"]);
  });
});
