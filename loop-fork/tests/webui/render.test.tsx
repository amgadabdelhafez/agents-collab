import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { projectSelectedRunConnection } from "../../src/webui/App";
import { FleetView } from "../../src/webui/components/FleetView";
import { RunWorkspace } from "../../src/webui/components/RunWorkspace";
import {
  fixtureFleetSnapshot,
  fixtureRunDetails,
  fixtureRuns as rawFixtureRuns,
} from "../../src/webui/fixtures";
import type { FleetRunDTO } from "../../src/webui/types";

const noop = () => undefined;
const fixtureRuns: readonly FleetRunDTO[] = rawFixtureRuns.map((candidate) => ({
  ...candidate,
  routeId: candidate.routeId || `${candidate.repoId}:${candidate.runId}`,
}));

describe("Web UI server-rendered contract", () => {
  test("renders fleet triage and the read-only run workspace", () => {
    const fleetMarkup = renderToStaticMarkup(
      <FleetView
        connectionLabel={fixtureFleetSnapshot.connection.label}
        connectionState={fixtureFleetSnapshot.connection.state}
        dataSource={fixtureFleetSnapshot.dataSource}
        lifecycleFilter="all"
        onLifecycleFilterChange={noop}
        onPausedChange={noop}
        onRepositoryFilterChange={noop}
        onSearchChange={noop}
        onSelectRun={noop}
        paused={false}
        queuedUpdates={fixtureFleetSnapshot.connection.queuedUpdates}
        repositoryFilter="all"
        runs={fixtureRuns}
        search=""
      />
    );

    expect(fleetMarkup).toContain("Run fleet");
    expect(fleetMarkup).toContain("Needs attention");
    expect(fleetMarkup).toContain("Cleanup debt");
    expect(fleetMarkup).toContain("Active");
    expect(fleetMarkup).toContain("Finished");
    expect(fleetMarkup).toContain("Read-only next step");
    expect(fleetMarkup).toContain("loop attach --run-id relay-214");
    expect(fleetMarkup).toContain("Adapter details");
    expect(fleetMarkup).toContain("Data quality");
    expect(fleetMarkup).toContain(
      "Synthetic fixture data, not a live runtime."
    );
    expect(fleetMarkup).not.toContain(">Live<");

    const relaySummary = fixtureRuns.find(
      (candidate) => candidate.runId === "relay-214"
    );
    const run = relaySummary
      ? fixtureRunDetails[relaySummary.routeId]
      : undefined;
    if (!run) {
      throw new Error("Missing relay-214 workspace fixture");
    }
    const [firstAgent, secondAgent] = run.agents;
    if (!(firstAgent && secondAgent)) {
      throw new Error("relay-214 must preserve both frontier agent seats");
    }

    const workspaceMarkup = renderToStaticMarkup(
      <RunWorkspace onBack={noop} run={run} />
    );

    expect(workspaceMarkup).toContain("Read-only release");
    expect(workspaceMarkup).toContain("Current driver");
    expect(workspaceMarkup).toContain(run.authority.currentDriver);
    expect(workspaceMarkup).toContain("Governess epoch");
    expect(workspaceMarkup).toContain(run.authority.epoch);
    expect(workspaceMarkup).toContain(firstAgent.displayName);
    expect(workspaceMarkup).toContain(secondAgent.displayName);
    expect(workspaceMarkup).toContain("Governess");
    expect(workspaceMarkup).toContain("Bounded worker activity");
    expect(workspaceMarkup).toContain("Timeline");
    expect(workspaceMarkup).toContain("Session limit");
    expect(workspaceMarkup).toContain("Weekly limit");
    expect(workspaceMarkup).toContain("Persistent run authority");
  });

  test("renders mixed repositories with collision-safe identities and generic live copy", () => {
    const base = fixtureRuns.find((run) => run.runId === "orbit-120");
    if (!base) {
      throw new Error("Missing orbit-120 fleet fixture");
    }

    const alpha: FleetRunDTO = {
      ...base,
      lifecycle: "blocked",
      reasons: [],
      repoId: "alpha-repo-aaaaaaaaaaaa",
      repository: "Alpha repository",
      routeId: "alpha-repo-aaaaaaaaaaaa:7",
      runId: "7",
      title: "Alpha loop seven",
    };
    const beta: FleetRunDTO = {
      ...base,
      lifecycle: "reviewing",
      reasons: [],
      repoId: "beta-repo-bbbbbbbbbbbb",
      repository: "Beta repository",
      routeId: "beta-repo-bbbbbbbbbbbb:7",
      runId: "7",
      title: "Beta loop seven",
    };
    const liveDataSource = {
      ...fixtureFleetSnapshot.dataSource,
      kind: "live-redacted" as const,
      scenario: "Loop registry",
    };

    const fleetMarkup = renderToStaticMarkup(
      <FleetView
        connectionLabel="Projection connected"
        connectionState="live"
        dataSource={liveDataSource}
        lifecycleFilter="all"
        onLifecycleFilterChange={noop}
        onPausedChange={noop}
        onRepositoryFilterChange={noop}
        onSearchChange={noop}
        onSelectRun={noop}
        paused={false}
        repositoryFilter="all"
        runs={[alpha, beta]}
        search=""
      />
    );

    expect(fleetMarkup).toContain(
      'value="alpha-repo-aaaaaaaaaaaa">Alpha repository'
    );
    expect(fleetMarkup).toContain(
      'value="beta-repo-bbbbbbbbbbbb">Beta repository'
    );
    expect(fleetMarkup).toContain("Alpha loop seven");
    expect(fleetMarkup).toContain("Beta loop seven");
    expect(fleetMarkup).toContain("status-blocked");
    expect(fleetMarkup).toContain(
      "Loop registry records connected, redacted at the server boundary."
    );
    expect(fleetMarkup).not.toContain("Harvto");

    const alphaOnlyMarkup = renderToStaticMarkup(
      <FleetView
        connectionLabel="Projection connected"
        connectionState="live"
        dataSource={liveDataSource}
        lifecycleFilter="all"
        onLifecycleFilterChange={noop}
        onPausedChange={noop}
        onRepositoryFilterChange={noop}
        onSearchChange={noop}
        onSelectRun={noop}
        paused={false}
        repositoryFilter={alpha.repoId}
        runs={[alpha, beta]}
        search=""
      />
    );

    expect(alphaOnlyMarkup).toContain("Alpha loop seven");
    expect(alphaOnlyMarkup).not.toContain("Beta loop seven");

    const workingOnlyMarkup = renderToStaticMarkup(
      <FleetView
        connectionLabel="Projection connected"
        connectionState="live"
        dataSource={liveDataSource}
        lifecycleFilter="working-set"
        onLifecycleFilterChange={noop}
        onPausedChange={noop}
        onRepositoryFilterChange={noop}
        onSearchChange={noop}
        onSelectRun={noop}
        paused={false}
        repositoryFilter="all"
        runs={[alpha, beta]}
        search=""
      />
    );

    expect(workingOnlyMarkup).not.toContain("Alpha loop seven");
    expect(workingOnlyMarkup).toContain("Beta loop seven");
  });

  test("renders each live connection state without claiming stale snapshots are connected", () => {
    const liveDataSource = {
      ...fixtureFleetSnapshot.dataSource,
      kind: "live-redacted" as const,
      notice: "Live registry data is redacted.",
      scenario: "Loop registry",
    };
    const renderConnection = (
      connectionState: "live" | "behind" | "reconnecting" | "offline",
      paused = false
    ) =>
      renderToStaticMarkup(
        <FleetView
          connectionLabel={
            connectionState === "behind"
              ? "Projection partial"
              : "Projection connected"
          }
          connectionState={connectionState}
          dataSource={liveDataSource}
          lifecycleFilter="all"
          onLifecycleFilterChange={noop}
          onPausedChange={noop}
          onRepositoryFilterChange={noop}
          onSearchChange={noop}
          onSelectRun={noop}
          paused={paused}
          repositoryFilter="all"
          runs={fixtureRuns.slice(0, 1)}
          search=""
        />
      );

    expect(renderConnection("live")).toContain("Projection connected");
    expect(renderConnection("reconnecting")).toContain(
      "Reconnecting to registry"
    );
    expect(renderConnection("live", true)).toContain("Live updates paused");

    const behindMarkup = renderConnection("behind");
    expect(behindMarkup).toContain("Projection partial");
    expect(behindMarkup).toContain(
      "The projection is behind. The last verified snapshot remains visible while unavailable updates catch up."
    );
    expect(behindMarkup).not.toContain("Projection connected");

    const offlineMarkup = renderConnection("offline");
    expect(offlineMarkup).toContain("Live refresh unavailable");
    expect(offlineMarkup).toContain(
      "Live refresh is unavailable. The last verified snapshot remains visible; fixture data was not substituted."
    );
    expect(offlineMarkup).not.toContain("Projection connected");

    const pausedOfflineMarkup = renderConnection("offline", true);
    expect(pausedOfflineMarkup).toContain("Live refresh unavailable");
    expect(pausedOfflineMarkup).not.toContain("Live updates paused");
  });

  test("marks a retained run detail offline after live refresh fails", () => {
    const run = Object.values(fixtureRunDetails)[0];
    if (!run) {
      throw new Error("Missing run detail fixture");
    }

    const projected = projectSelectedRunConnection(run, true, false);
    if (!projected) {
      throw new Error("Retained detail projection unexpectedly disappeared");
    }
    const markup = renderToStaticMarkup(
      <RunWorkspace onBack={noop} run={projected} />
    );

    expect(projected.connection).toMatchObject({
      label: "Live refresh unavailable",
      state: "offline",
    });
    expect(markup).toContain("Live refresh unavailable");
    expect(markup).not.toContain("Projection connected");
  });
});
