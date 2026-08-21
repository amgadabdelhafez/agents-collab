// biome-ignore-all lint/style/useFilenamingConvention: React component files use PascalCase in this Web UI.
import { useEffect, useMemo, useState } from "react";

import { FleetView } from "./components/FleetView";
import { RunWorkspace } from "./components/RunWorkspace";
import {
  fixtureFleetSnapshot,
  fixtureRunDetails,
  fixtureRuns,
} from "./fixtures";
import type { RunLifecycle } from "./types";

type AppRoute =
  | { readonly kind: "fleet" }
  | { readonly kind: "run"; readonly runId: string };

const RUN_HASH_PATTERN = /^#\/runs\/([^/]+)$/;

function routeFromHash(): AppRoute {
  const match = RUN_HASH_PATTERN.exec(window.location.hash);
  if (!match) {
    return { kind: "fleet" };
  }

  const runId = decodeURIComponent(match[1] ?? "");
  return fixtureRunDetails[runId] ? { kind: "run", runId } : { kind: "fleet" };
}

function pushRoute(route: AppRoute): void {
  const hash =
    route.kind === "fleet" ? "#/" : `#/runs/${encodeURIComponent(route.runId)}`;
  window.history.pushState(null, "", hash);
}

export function App() {
  const [route, setRoute] = useState<AppRoute>(routeFromHash);
  const [search, setSearch] = useState("");
  const [repositoryFilter, setRepositoryFilter] = useState("all");
  const [lifecycleFilter, setLifecycleFilter] = useState<RunLifecycle | "all">(
    "all"
  );
  const [paused, setPaused] = useState(false);

  const selectedRun =
    route.kind === "run" ? fixtureRunDetails[route.runId] : undefined;
  const projectedRun = useMemo(() => {
    if (!(selectedRun && paused)) {
      return selectedRun;
    }

    return {
      ...selectedRun,
      connection: {
        ...selectedRun.connection,
        label: "Updates paused",
        state: "paused" as const,
      },
    };
  }, [paused, selectedRun]);
  const activeRuns = useMemo(
    () =>
      fixtureRuns.filter((run) =>
        ["submitted", "working", "reviewing", "input-required"].includes(
          run.lifecycle
        )
      ),
    []
  );

  useEffect(() => {
    const followBrowserLocation = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", followBrowserLocation);
    window.addEventListener("popstate", followBrowserLocation);
    return () => {
      window.removeEventListener("hashchange", followBrowserLocation);
      window.removeEventListener("popstate", followBrowserLocation);
    };
  }, []);

  const navigate = (nextRoute: AppRoute) => {
    pushRoute(nextRoute);
    setRoute(nextRoute);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const showFleet = (mode: "all" | "working" = "all") => {
    setSearch("");
    setRepositoryFilter("all");
    setLifecycleFilter(mode === "working" ? "working" : "all");
    navigate({ kind: "fleet" });
  };

  return (
    <div className="app-shell">
      <aside aria-label="Primary navigation" className="app-nav">
        <button
          aria-label="Open Loop fleet"
          className="brand-mark"
          onClick={() => showFleet()}
          type="button"
        >
          L
        </button>
        <nav aria-label="Views" className="nav-list">
          <button
            aria-current={
              route.kind === "fleet" && lifecycleFilter === "all"
                ? "page"
                : undefined
            }
            className="nav-item"
            onClick={() => showFleet()}
            type="button"
          >
            <span aria-hidden="true" className="nav-symbol">
              ⌁
            </span>
            Fleet
          </button>
          <button
            aria-current={
              route.kind === "fleet" && lifecycleFilter === "working"
                ? "page"
                : undefined
            }
            className="nav-item"
            onClick={() => showFleet("working")}
            type="button"
          >
            <span aria-hidden="true" className="nav-symbol">
              ●
            </span>
            Working
          </button>
          <button
            aria-current={route.kind === "run" ? "page" : undefined}
            className="nav-item"
            disabled={!selectedRun}
            onClick={() =>
              selectedRun &&
              navigate({ kind: "run", runId: selectedRun.summary.runId })
            }
            type="button"
          >
            <span aria-hidden="true" className="nav-symbol">
              ▦
            </span>
            Run
          </button>
        </nav>
        <div className="nav-footer" title="Local read-only fixture projection">
          <span className="nav-mode-dot" title="Read-only fixture projection" />
          <span className="nav-mode-label">Local</span>
        </div>
      </aside>

      <div className="app-content">
        <header className="global-header">
          <div className="global-title">
            <span className="global-context">Agents Collab</span>
            <span aria-hidden="true" className="global-divider">
              /
            </span>
            <span className="global-page-title">
              {projectedRun?.summary.title ?? "Run fleet"}
            </span>
          </div>
          <div className="global-actions">
            <span className="global-run-count">
              {activeRuns.length} fixture runs active
            </span>
            <span
              className="connection-pill"
              data-state={
                paused ? "paused" : fixtureFleetSnapshot.connection.state
              }
            >
              {paused ? "Updates paused" : "Fixture snapshot"}
            </span>
          </div>
        </header>

        {projectedRun ? (
          <RunWorkspace onBack={() => showFleet()} run={projectedRun} />
        ) : (
          <div className="page-container">
            <FleetView
              connectionState={fixtureFleetSnapshot.connection.state}
              fixtureNotice={fixtureFleetSnapshot.fixtureSource.notice}
              lifecycleFilter={lifecycleFilter}
              onLifecycleFilterChange={setLifecycleFilter}
              onPausedChange={setPaused}
              onRepositoryFilterChange={setRepositoryFilter}
              onSearchChange={setSearch}
              onSelectRun={(runId) => navigate({ kind: "run", runId })}
              paused={paused}
              queuedUpdates={fixtureFleetSnapshot.connection.queuedUpdates}
              repositoryFilter={repositoryFilter}
              runs={fixtureRuns}
              search={search}
            />
          </div>
        )}
      </div>
    </div>
  );
}
