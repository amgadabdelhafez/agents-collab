import { describe, expect, test } from "bun:test";
import { fixtureRuns as rawFixtureRuns } from "../../src/webui/fixtures";
import {
  filterAndGroupRuns,
  getPrimaryRunGroup,
} from "../../src/webui/selectors";
import type { FleetRunDTO } from "../../src/webui/types";

const fixtureRuns: readonly FleetRunDTO[] = rawFixtureRuns.map((candidate) => ({
  ...candidate,
  routeId: candidate.routeId || `${candidate.repoId}:${candidate.runId}`,
}));

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
      new Set(groups.flatMap((group) => group.runs.map((item) => item.routeId)))
        .size
    ).toBe(fixtureRuns.length);
  });

  test("keeps blocked runs in needs attention and out of the working set", () => {
    const base = run("orbit-120");
    const blocked: FleetRunDTO = {
      ...base,
      lifecycle: "blocked",
      reasons: [],
      repoId: "blocked-repo-cccccccccccc",
      repository: "Blocked repository",
      routeId: "blocked-repo-cccccccccccc:8",
      runId: "8",
    };

    expect(getPrimaryRunGroup(blocked)).toBe("needs-attention");
    const working = filterAndGroupRuns([blocked, run("ridge-301")], {
      lifecycle: ["working", "reviewing"],
    });
    expect(
      working.flatMap((group) => group.runs.map((item) => item.routeId))
    ).not.toContain(blocked.routeId);
  });

  test("keeps a working run active while its manifest lifecycle catches up", () => {
    const base = run("ridge-301");
    const manifestBehind: FleetRunDTO = {
      ...base,
      lifecycle: "working",
      reasons: [
        {
          code: "active-looking-manifest",
          detail: "Newer durable lifecycle metadata reports working.",
          label: "Manifest lifecycle behind",
          severity: "medium",
        },
      ],
    };

    expect(getPrimaryRunGroup(manifestBehind)).toBe("active");
    expect(
      idsByGroup(filterAndGroupRuns([manifestBehind]), "cleanup-debt")
    ).toEqual([]);
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
    const ridgeRepoId = run("ridge-301").repoId;
    const ridgeReview = filterAndGroupRuns(fixtureRuns, {
      repository: ridgeRepoId,
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
      routeId: `${base.repoId}:stable-b`,
      runId: "stable-b",
      repository: "paperkite/same",
    };
    const sameTimeA: FleetRunDTO = {
      ...base,
      routeId: `${base.repoId}:stable-a`,
      runId: "stable-a",
      repository: "paperkite/same",
    };

    const forward = filterAndGroupRuns([sameTimeB, sameTimeA]);
    const reverse = filterAndGroupRuns([sameTimeA, sameTimeB]);
    expect(idsByGroup(forward, "finished")).toEqual(["stable-a", "stable-b"]);
    expect(idsByGroup(reverse, "finished")).toEqual(["stable-a", "stable-b"]);
  });

  test("keeps identical run ids collision-safe across repositories", () => {
    const base = run("orbit-120");
    const alpha: FleetRunDTO = {
      ...base,
      repoId: "alpha-repo-aaaaaaaaaaaa",
      repository: "Shared label",
      routeId: "alpha-repo-aaaaaaaaaaaa:7",
      runId: "7",
    };
    const beta: FleetRunDTO = {
      ...base,
      repoId: "beta-repo-bbbbbbbbbbbb",
      repository: "Shared label",
      routeId: "beta-repo-bbbbbbbbbbbb:7",
      runId: "7",
    };

    const all = filterAndGroupRuns([beta, alpha]);
    expect(
      all.flatMap((group) => group.runs.map((item) => item.routeId))
    ).toEqual([alpha.routeId, beta.routeId]);

    const alphaOnly = filterAndGroupRuns([alpha, beta], {
      repository: alpha.repoId,
    });
    expect(
      alphaOnly.flatMap((group) => group.runs.map((item) => item.routeId))
    ).toEqual([alpha.routeId]);
  });
});
