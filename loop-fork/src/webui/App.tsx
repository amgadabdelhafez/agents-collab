// biome-ignore-all lint/style/useFilenamingConvention: React component files use PascalCase in this Web UI.
import { useEffect, useMemo, useState } from "react";

import { fetchLiveSnapshot, LiveSnapshotError } from "./api";
import { FleetView } from "./components/FleetView";
import { RunWorkspace } from "./components/RunWorkspace";
import type { RunLifecycle, WebUiSnapshotDTO } from "./types";

type AppRoute =
  | { readonly kind: "fleet" }
  | { readonly kind: "run"; readonly runId: string };

const RUN_HASH_PATTERN = /^#\/runs\/([a-zA-Z0-9][a-zA-Z0-9._:-]{0,127})$/;
const REFRESH_INTERVAL_MS = 5000;
const WORKING_LIFECYCLES: ReadonlySet<RunLifecycle> = new Set([
  "working",
  "reviewing",
]);

interface LiveSnapshotState {
  readonly error?: LiveSnapshotError;
  readonly retry: () => void;
  readonly snapshot?: WebUiSnapshotDTO;
}

function useLiveSnapshot(paused: boolean): LiveSnapshotState {
  const [snapshot, setSnapshot] = useState<WebUiSnapshotDTO>();
  const [error, setError] = useState<LiveSnapshotError>();
  const [requestKey, setRequestKey] = useState(0);

  useEffect(() => {
    if (paused) {
      return;
    }
    let active = true;
    let controller: AbortController | undefined;
    const refresh = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const next = await fetchLiveSnapshot(controller.signal, requestKey);
        if (active) {
          setSnapshot(next);
          setError(undefined);
        }
      } catch (caught) {
        if (
          active &&
          !(caught instanceof DOMException && caught.name === "AbortError")
        ) {
          setError(
            caught instanceof LiveSnapshotError
              ? caught
              : new LiveSnapshotError()
          );
        }
      }
    };
    refresh();
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [paused, requestKey]);

  return {
    error,
    retry: () => {
      setError(undefined);
      setRequestKey((value) => value + 1);
    },
    snapshot,
  };
}

function connectionPresentation(
  error: LiveSnapshotError | undefined,
  paused: boolean,
  snapshot: WebUiSnapshotDTO | undefined
) {
  if (error) {
    return { label: "Live data unavailable", state: "offline" as const };
  }
  if (paused) {
    return { label: "Updates paused", state: "paused" as const };
  }
  return {
    label: snapshot?.fleet.connection.label ?? "Connecting",
    state: snapshot?.fleet.connection.state ?? ("reconnecting" as const),
  };
}

function countWorkingRuns(snapshot: WebUiSnapshotDTO | undefined): number {
  return (
    snapshot?.fleet.runs.filter((run) => WORKING_LIFECYCLES.has(run.lifecycle))
      .length ?? 0
  );
}

function routeFromHash(): AppRoute {
  const match = RUN_HASH_PATTERN.exec(window.location.hash);
  return match?.[1]
    ? { kind: "run", runId: decodeURIComponent(match[1]) }
    : { kind: "fleet" };
}

function pushRoute(route: AppRoute): void {
  const hash =
    route.kind === "fleet" ? "#/" : `#/runs/${encodeURIComponent(route.runId)}`;
  window.history.pushState(null, "", hash);
}

function LoadingState() {
  return (
    <main className="page-container live-state-page" id="main-content">
      <section aria-live="polite" className="surface live-state-card">
        <span aria-hidden="true" className="status-dot status-reconnecting" />
        <div>
          <p className="eyebrow">Harvto lane</p>
          <h1>Connecting to durable run data</h1>
          <p>
            Reading the bounded, redacted projection. No runtime state is being
            changed.
          </p>
        </div>
      </section>
    </main>
  );
}

function UnavailableState({
  onRetry,
  status,
}: {
  readonly onRetry: () => void;
  readonly status?: number;
}) {
  return (
    <main className="page-container live-state-page" id="main-content">
      <section
        aria-live="assertive"
        className="surface live-state-card live-state-card--error"
      >
        <span aria-hidden="true" className="status-dot status-offline" />
        <div>
          <p className="eyebrow">Harvto lane</p>
          <h1>Live data unavailable</h1>
          <p>
            The adapter failed closed, so fixture data was not substituted.
            Check the durable lane evidence and try again.
          </p>
          {status ? (
            <p className="live-state-code">Adapter status {status}</p>
          ) : null}
          <button className="primary-button" onClick={onRetry} type="button">
            Retry live connection
          </button>
        </div>
      </section>
    </main>
  );
}

export function App() {
  const [route, setRoute] = useState<AppRoute>(routeFromHash);
  const [search, setSearch] = useState("");
  const [repositoryFilter, setRepositoryFilter] = useState("all");
  const [lifecycleFilter, setLifecycleFilter] = useState<RunLifecycle | "all">(
    "all"
  );
  const [paused, setPaused] = useState(false);
  const { error, retry, snapshot } = useLiveSnapshot(paused);

  useEffect(() => {
    const followBrowserLocation = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", followBrowserLocation);
    window.addEventListener("popstate", followBrowserLocation);
    return () => {
      window.removeEventListener("hashchange", followBrowserLocation);
      window.removeEventListener("popstate", followBrowserLocation);
    };
  }, []);

  const selectedRun =
    route.kind === "run" ? snapshot?.details[route.runId] : undefined;
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
  const workingRunCount = countWorkingRuns(snapshot);
  const liveConnection = connectionPresentation(error, paused, snapshot);

  useEffect(() => {
    if (snapshot && route.kind === "run" && !selectedRun) {
      pushRoute({ kind: "fleet" });
      setRoute({ kind: "fleet" });
    }
  }, [route, selectedRun, snapshot]);

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
        <div className="nav-footer" title="Local read-only Harvto projection">
          <span className="nav-mode-dot" title="Read-only live projection" />
          <span className="nav-mode-label">Read only</span>
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
              {projectedRun?.summary.title ?? "Harvto run fleet"}
            </span>
          </div>
          <div className="global-actions">
            <span className="global-run-count">
              {workingRunCount} Harvto run
              {workingRunCount === 1 ? "" : "s"} working
            </span>
            <span className="connection-pill" data-state={liveConnection.state}>
              {liveConnection.label}
            </span>
          </div>
        </header>

        {snapshot || error ? null : <LoadingState />}
        {!snapshot && error ? (
          <UnavailableState onRetry={retry} status={error.status} />
        ) : null}
        {snapshot && error ? (
          <div className="page-container live-inline-error" role="alert">
            <strong>Live refresh failed.</strong> The last verified snapshot
            remains visible; fixture data was not substituted.
            <button className="icon-button" onClick={retry} type="button">
              Retry
            </button>
          </div>
        ) : null}
        {snapshot && projectedRun ? (
          <RunWorkspace onBack={() => showFleet()} run={projectedRun} />
        ) : null}
        {snapshot && !projectedRun ? (
          <div className="page-container">
            <FleetView
              connectionState={
                error ? "offline" : snapshot.fleet.connection.state
              }
              dataSource={snapshot.fleet.dataSource}
              lifecycleFilter={lifecycleFilter}
              onLifecycleFilterChange={setLifecycleFilter}
              onPausedChange={setPaused}
              onRepositoryFilterChange={setRepositoryFilter}
              onSearchChange={setSearch}
              onSelectRun={(runId) => navigate({ kind: "run", runId })}
              paused={paused}
              queuedUpdates={snapshot.fleet.connection.queuedUpdates}
              repositoryFilter={repositoryFilter}
              runs={snapshot.fleet.runs}
              search={search}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
