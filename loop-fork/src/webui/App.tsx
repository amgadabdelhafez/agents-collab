// biome-ignore-all lint/style/useFilenamingConvention: React component files use PascalCase in this Web UI.
import { useEffect, useMemo, useState } from "react";

import { fetchLiveSnapshot, isRunRouteId, LiveSnapshotError } from "./api";
import { AppearanceControl } from "./components/AppearanceControl";
import { type FleetLifecycleFilter, FleetView } from "./components/FleetView";
import { RunWorkspace } from "./components/RunWorkspace";
import { useAppearanceMode } from "./theme";
import type {
  ConnectionState,
  RunDetailDTO,
  RunLifecycle,
  WebUiSnapshotDTO,
} from "./types";

type AppRoute =
  | { readonly kind: "fleet" }
  | { readonly kind: "run"; readonly routeId: string };

const RUN_HASH_PATTERN = /^#\/runs\/([^/?#]+)$/u;
const REFRESH_INTERVAL_MS = 5000;
const WORKING_LIFECYCLES: ReadonlySet<RunLifecycle> = new Set([
  "working",
  "reviewing",
]);
const CONNECTION_LABELS = {
  behind: "Projection behind",
  live: "Projection connected",
  offline: "Live data unavailable",
  paused: "Updates paused",
  reconnecting: "Reconnecting to registry",
} satisfies Readonly<Record<ConnectionState, string>>;

const lifecycleFilterForMode = (
  mode: "all" | "working"
): FleetLifecycleFilter => (mode === "working" ? "working-set" : "all");

const globalPageTitle = (
  route: AppRoute,
  selectedTitle: string | undefined
): string =>
  selectedTitle ??
  (route.kind === "run" ? "Run unavailable" : "Loop run fleet");

const coverageSummary = (covered: number, working: number): string =>
  `${covered} loop${covered === 1 ? "" : "s"} covered and ${working} working`;

const navigateToSelectedRoute = (
  routeId: string | undefined,
  navigate: (route: AppRoute) => void
): void => {
  if (routeId) {
    navigate({ kind: "run", routeId });
  }
};

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
  if (!snapshot) {
    return { label: "Connecting", state: "reconnecting" as const };
  }
  const state = snapshot.fleet.connection.state;
  return {
    label:
      state === "live" || state === "behind"
        ? snapshot.fleet.connection.label
        : CONNECTION_LABELS[state],
    state,
  };
}

function countWorkingRuns(snapshot: WebUiSnapshotDTO | undefined): number {
  return (
    snapshot?.fleet.runs.filter((run) => WORKING_LIFECYCLES.has(run.lifecycle))
      .length ?? 0
  );
}

export function projectSelectedRunConnection(
  selectedRun: RunDetailDTO | undefined,
  refreshFailed: boolean,
  paused: boolean
): RunDetailDTO | undefined {
  if (!selectedRun) {
    return undefined;
  }
  if (!(refreshFailed || paused)) {
    return selectedRun;
  }
  return {
    ...selectedRun,
    connection: {
      ...selectedRun.connection,
      label: refreshFailed ? "Live refresh unavailable" : "Updates paused",
      state: refreshFailed ? "offline" : "paused",
    },
  };
}

function routeFromHash(): AppRoute {
  const match = RUN_HASH_PATTERN.exec(window.location.hash);
  if (!match?.[1]) {
    return { kind: "fleet" };
  }
  try {
    const routeId = decodeURIComponent(match[1]);
    return isRunRouteId(routeId) ? { kind: "run", routeId } : { kind: "fleet" };
  } catch {
    return { kind: "fleet" };
  }
}

function pushRoute(route: AppRoute): void {
  const hash =
    route.kind === "fleet"
      ? "#/"
      : `#/runs/${encodeURIComponent(route.routeId)}`;
  window.history.pushState(null, "", hash);
}

function LoadingState() {
  return (
    <main className="page-container live-state-page" id="main-content">
      <section aria-live="polite" className="surface live-state-card">
        <span aria-hidden="true" className="status-dot status-reconnecting" />
        <div>
          <p className="eyebrow">Loop registry</p>
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
          <p className="eyebrow">Loop registry</p>
          <h1>Live data unavailable</h1>
          <p>
            The adapter failed closed, so fixture data was not substituted.
            Check the durable loop evidence and try again.
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

function RunUnavailableState({ onBack }: { readonly onBack: () => void }) {
  return (
    <main className="page-container live-state-page" id="main-content">
      <section aria-live="polite" className="surface live-state-card">
        <span aria-hidden="true" className="status-dot status-partial" />
        <div>
          <p className="eyebrow">Loop registry</p>
          <h1>Run no longer active</h1>
          <p>
            The selected run is not present in the latest verified registry
            snapshot. It may have finished or become unavailable.
          </p>
          <button className="primary-button" onClick={onBack} type="button">
            Return to fleet
          </button>
        </div>
      </section>
    </main>
  );
}

function RunUnavailableBoundary({
  hasRun,
  hasSnapshot,
  onBack,
  routeKind,
}: {
  readonly hasRun: boolean;
  readonly hasSnapshot: boolean;
  readonly onBack: () => void;
  readonly routeKind: AppRoute["kind"];
}) {
  if (!(hasSnapshot && routeKind === "run" && !hasRun)) {
    return null;
  }
  return <RunUnavailableState onBack={onBack} />;
}

export function App() {
  const appearance = useAppearanceMode();
  const [route, setRoute] = useState<AppRoute>(routeFromHash);
  const [search, setSearch] = useState("");
  const [repositoryFilter, setRepositoryFilter] = useState("all");
  const [lifecycleFilter, setLifecycleFilter] =
    useState<FleetLifecycleFilter>("all");
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
    route.kind === "run" ? snapshot?.details[route.routeId] : undefined;
  const projectedRun = useMemo(
    () =>
      projectSelectedRunConnection(selectedRun, error !== undefined, paused),
    [error, paused, selectedRun]
  );
  const coveredLoopCount = snapshot?.fleet.runs.length ?? 0;
  const workingRunCount = countWorkingRuns(snapshot);
  const liveConnection = connectionPresentation(error, paused, snapshot);

  const navigate = (nextRoute: AppRoute) => {
    pushRoute(nextRoute);
    setRoute(nextRoute);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const showFleet = (mode: "all" | "working" = "all") => {
    setSearch("");
    setRepositoryFilter("all");
    setLifecycleFilter(lifecycleFilterForMode(mode));
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
              route.kind === "fleet" && lifecycleFilter === "working-set"
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
              navigateToSelectedRoute(selectedRun?.summary.routeId, navigate)
            }
            type="button"
          >
            <span aria-hidden="true" className="nav-symbol">
              ▦
            </span>
            Run
          </button>
        </nav>
        <div className="nav-footer" title="Local read-only loop projection">
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
              {globalPageTitle(route, projectedRun?.summary.title)}
            </span>
          </div>
          <div className="global-actions">
            <AppearanceControl
              mode={appearance.mode}
              onChange={appearance.setMode}
            />
            <span className="global-run-count">
              {coverageSummary(coveredLoopCount, workingRunCount)}
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
        <RunUnavailableBoundary
          hasRun={projectedRun !== undefined}
          hasSnapshot={snapshot !== undefined}
          onBack={() => showFleet()}
          routeKind={route.kind}
        />
        {snapshot && route.kind === "fleet" ? (
          <div className="page-container">
            <FleetView
              connectionLabel={snapshot.fleet.connection.label}
              connectionState={
                error ? "offline" : snapshot.fleet.connection.state
              }
              dataSource={snapshot.fleet.dataSource}
              lifecycleFilter={lifecycleFilter}
              onLifecycleFilterChange={setLifecycleFilter}
              onPausedChange={setPaused}
              onRepositoryFilterChange={setRepositoryFilter}
              onSearchChange={setSearch}
              onSelectRun={(routeId) => navigate({ kind: "run", routeId })}
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
