import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FleetView } from "../../src/webui/components/FleetView";
import { RunWorkspace } from "../../src/webui/components/RunWorkspace";
import {
  fixtureFleetSnapshot,
  fixtureRunDetails,
  fixtureRuns,
} from "../../src/webui/fixtures";

const noop = () => undefined;

describe("Web UI server-rendered contract", () => {
  test("renders fleet triage and the read-only run workspace", () => {
    const fleetMarkup = renderToStaticMarkup(
      <FleetView
        connectionState={fixtureFleetSnapshot.connection.state}
        fixtureNotice={fixtureFleetSnapshot.fixtureSource.notice}
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

    const run = fixtureRunDetails["relay-214"];
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
});
