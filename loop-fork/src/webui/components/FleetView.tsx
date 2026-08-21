// biome-ignore-all lint/style/useFilenamingConvention: React component files use PascalCase in this Web UI.
import { useId, useState } from "react";

import { filterAndGroupRuns } from "../selectors";
import type {
  ConnectionState,
  DataSourceDTO,
  FleetFilterOptions,
  FleetGroupKey,
  FleetRunDTO,
  FleetRunGroupDTO,
  RunLifecycle,
  RunReasonCode,
} from "../types";

const LIFECYCLE_OPTIONS: ReadonlyArray<{
  value: RunLifecycle;
  label: string;
}> = [
  { value: "submitted", label: "Submitted" },
  { value: "working", label: "Working" },
  { value: "reviewing", label: "Reviewing" },
  { value: "input-required", label: "Input required" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "stopped", label: "Stopped" },
];

const GROUP_DESCRIPTIONS = {
  "needs-attention": "Waiting on a decision or trustworthy authority.",
  "cleanup-debt": "Ended runs with runtime residue to reconcile.",
  active: "Submitted, working, or under review.",
  finished: "Completed, failed, or deliberately stopped.",
} satisfies Record<FleetGroupKey, string>;

const PRIMARY_REASON_CODES: Partial<
  Record<FleetGroupKey, readonly RunReasonCode[]>
> = {
  "needs-attention": [
    "input-required",
    "failed-control",
    "stale-authority",
    "corrupt-evidence",
    "identity-conflict",
  ],
  "cleanup-debt": ["surviving-adapter", "active-looking-manifest"],
};

const REASON_GUIDANCE: Partial<Record<RunReasonCode, string>> = {
  "input-required":
    "A person needs to answer before this run can continue. Open the validated run in your terminal to respond.",
  "failed-control":
    "A control did not complete. Inspect the durable audit in your terminal before deciding whether to retry it.",
  "surviving-adapter":
    "The run ended, but a runtime adapter still appears present. Reconcile it deliberately from the terminal.",
  "active-looking-manifest":
    "The persisted lifecycle and runtime evidence disagree. Verify the run in your terminal before cleanup.",
  "stale-authority":
    "Current authority evidence is stale. Treat this browser view as informational until you verify the run.",
  "corrupt-evidence":
    "Required durable evidence could not be read safely. Inspect the source from the terminal before acting.",
  "identity-conflict":
    "Identity sources conflict. The browser will not choose an authority; verify the run from the terminal.",
};

const VALIDATED_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export interface FleetViewProps {
  readonly connectionState: ConnectionState;
  readonly dataSource: DataSourceDTO;
  readonly lifecycleFilter: RunLifecycle | "all";
  readonly onLifecycleFilterChange: (value: RunLifecycle | "all") => void;
  readonly onPausedChange: (paused: boolean) => void;
  readonly onRepositoryFilterChange: (value: string) => void;
  readonly onSearchChange: (value: string) => void;
  readonly onSelectRun: (runId: string) => void;
  readonly paused: boolean;
  readonly queuedUpdates?: number;
  readonly repositoryFilter: string;
  readonly runs: readonly FleetRunDTO[];
  readonly search: string;
}

interface RunCardProps {
  readonly copyState: CopyState | null;
  readonly group: FleetRunGroupDTO;
  readonly onCopyAttach: (run: FleetRunDTO) => void;
  readonly onSelectRun: (runId: string) => void;
  readonly run: FleetRunDTO;
}

interface CopyState {
  readonly runId: string;
  readonly status: "copied" | "failed";
}

function fleetConnectionPresentation(paused: boolean, isLive: boolean) {
  if (paused) {
    return {
      description: "The last verified snapshot stays on screen",
      label: "Live updates paused",
    };
  }
  if (isLive) {
    return {
      description: "Read-only durable projection",
      label: "Projection connected",
    };
  }
  return {
    description: "Synthetic demo data, not live runtime",
    label: "Fixture snapshot",
  };
}

function formatAge(timestamp: string): string {
  const observedAt = Date.parse(timestamp);
  if (!Number.isFinite(observedAt)) {
    return "Age unknown";
  }

  const seconds = Math.max(0, Math.floor((Date.now() - observedAt) / 1000));
  if (seconds < 60) {
    return "Just now";
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${Math.floor(hours / 24)}d ago`;
}

function formatTimestamp(timestamp: string): string {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) {
    return "Unknown time";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function getGuidance(run: FleetRunDTO, group: FleetRunGroupDTO): string {
  for (const reason of run.reasons) {
    const guidance = REASON_GUIDANCE[reason.code];
    if (guidance) {
      return guidance;
    }
  }

  if (group.key === "cleanup-debt") {
    return "This ended run still has cleanup debt. Inspect it from the terminal before reconciling any runtime residue.";
  }

  if (group.key === "finished") {
    return "This run is finished. Open its validated terminal record when you need the complete durable history.";
  }

  return "This browser is read-only. Continue the run from its validated terminal session when interaction is required.";
}

function RunCard({
  run,
  group,
  copyState,
  onCopyAttach,
  onSelectRun,
}: RunCardProps) {
  const cardHeadingId = useId();
  const primaryReasonCodes = PRIMARY_REASON_CODES[group.key];
  const primaryReason = run.reasons.find((reason) =>
    primaryReasonCodes?.includes(reason.code)
  );
  const secondaryReasons = run.reasons.filter(
    (reason) => reason !== primaryReason
  );
  const runtimeAttachable = run.adapters.some(
    (adapter) =>
      adapter.kind === "tmux" &&
      (adapter.state === "healthy" || adapter.state === "surviving")
  );
  const canAttach = VALIDATED_RUN_ID.test(run.runId) && runtimeAttachable;
  const attachCommand = canAttach
    ? `loop attach --run-id ${run.runId}`
    : "Attach unavailable: terminal identity is not fully verified";
  const copyResult = copyState?.runId === run.runId ? copyState.status : null;

  return (
    <article
      aria-labelledby={cardHeadingId}
      className={`surface run-card status-${run.lifecycle} quality-${run.quality.severity}`}
      data-group={group.key}
    >
      <div className="run-card-main">
        <button
          className="run-open-button"
          onClick={() => onSelectRun(run.runId)}
          type="button"
        >
          <span className="run-identity">
            <span className="run-repository">{run.repository}</span>
            <span className="run-worktree" title={run.worktree}>
              {run.worktree}
            </span>
          </span>

          <span className="run-title-block">
            <strong className="run-title" id={cardHeadingId}>
              {run.title}
            </strong>
            <span className="run-id">{run.runId}</span>
          </span>

          <span className="run-card-facts">
            <span className={`chip status-${run.lifecycle}`}>
              {run.lifecycle.replaceAll("-", " ")}
            </span>
            <span className="run-driver">
              <span className="run-fact-label">Driver</span>
              {run.driver}
            </span>
            <time
              className="run-age"
              dateTime={run.lastDurableEventAt}
              title={formatTimestamp(run.lastDurableEventAt)}
            >
              {formatAge(run.lastDurableEventAt)}
            </time>
          </span>

          <span aria-hidden="true" className="run-open-label">
            Open run
          </span>
        </button>
      </div>

      <div className="run-signal-row">
        <span
          className={`chip quality-${run.quality.severity}`}
          title={run.quality.summary}
        >
          Data {run.quality.label.toLowerCase()}
        </span>
        {primaryReason ? (
          <span
            className={`chip status-${primaryReason.severity}`}
            title={primaryReason.detail}
          >
            {primaryReason.label}
          </span>
        ) : null}
        {secondaryReasons.map((reason) => (
          <span
            className={`chip run-reason status-${reason.severity}`}
            key={reason.code}
            title={reason.detail}
          >
            {reason.label}
          </span>
        ))}
      </div>

      <ul aria-label={`${run.title} agent status`} className="run-agents">
        {run.agents.map((agent) => (
          <li className={`run-agent status-${agent.lifecycle}`} key={agent.id}>
            <span aria-hidden="true" className="status-dot" />
            <span className="run-agent-name">{agent.displayName}</span>
            <span className="run-agent-role">{agent.role}</span>
            <span className="run-agent-state">
              {agent.lifecycle.replaceAll("-", " ")}
            </span>
          </li>
        ))}
      </ul>

      <details className="run-details">
        <summary>
          Details and adapters
          <span className="run-details-count">
            {run.adapters.length} adapter{run.adapters.length === 1 ? "" : "s"}
          </span>
        </summary>

        <div className="run-details-grid">
          <section
            aria-labelledby={`${cardHeadingId}-next`}
            className="run-guidance"
          >
            <p className="eyebrow">Terminal fallback</p>
            <h4 id={`${cardHeadingId}-next`}>Read-only next step</h4>
            <p>{getGuidance(run, group)}</p>
            <div className="run-command-row">
              <code>{attachCommand}</code>
              <button
                aria-label={`Copy attach command for ${run.title}`}
                className="icon-button run-copy-button"
                disabled={!canAttach}
                onClick={() => onCopyAttach(run)}
                type="button"
              >
                {copyResult === "copied" ? "Copied" : "Copy"}
              </button>
            </div>
            <span className="run-copy-status" role="status">
              {copyResult === "failed"
                ? "Clipboard unavailable. Select the command to copy it."
                : ""}
            </span>
          </section>

          <section
            aria-labelledby={`${cardHeadingId}-adapters`}
            className="run-adapters"
          >
            <p className="eyebrow">Runtime boundary</p>
            <h4 id={`${cardHeadingId}-adapters`}>Adapter details</h4>
            {run.adapters.length > 0 ? (
              <ul>
                {run.adapters.map((adapter) => (
                  <li
                    className={`run-adapter status-${adapter.state}`}
                    key={`${adapter.kind}-${adapter.label}`}
                  >
                    <span className="run-adapter-kind">{adapter.kind}</span>
                    <span className="run-adapter-label">{adapter.label}</span>
                    <span className={`chip status-${adapter.state}`}>
                      {adapter.state}
                    </span>
                    <time
                      dateTime={adapter.lastProbedAt}
                      title={formatTimestamp(adapter.lastProbedAt)}
                    >
                      {formatAge(adapter.lastProbedAt)}
                    </time>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="run-empty-detail">
                No adapter facts were reported.
              </p>
            )}
          </section>

          <section
            aria-labelledby={`${cardHeadingId}-quality`}
            className="run-quality"
          >
            <p className="eyebrow">Data quality</p>
            <h4 id={`${cardHeadingId}-quality`}>{run.quality.label}</h4>
            <p>{run.quality.summary}</p>
            <ul className="run-provenance">
              {run.quality.sources.map((source) => (
                <li
                  className={`quality-source quality-${source.state}`}
                  key={source.sourceId}
                >
                  <span>{source.sourceKind.replaceAll("-", " ")}</span>
                  <span className={`chip quality-${source.state}`}>
                    {source.state}
                  </span>
                  <time
                    dateTime={source.observedAt}
                    title={formatTimestamp(source.observedAt)}
                  >
                    {formatAge(source.observedAt)}
                  </time>
                </li>
              ))}
            </ul>
            <p className="run-fixture-note">
              <strong>{run.dataSource.scenario}</strong>
              {run.dataSource.notice}
            </p>
          </section>
        </div>
      </details>
    </article>
  );
}

export function FleetView({
  runs,
  search,
  repositoryFilter,
  lifecycleFilter,
  connectionState,
  dataSource,
  queuedUpdates = 0,
  paused,
  onSearchChange,
  onRepositoryFilterChange,
  onLifecycleFilterChange,
  onPausedChange,
  onSelectRun,
}: FleetViewProps) {
  const [copyState, setCopyState] = useState<CopyState | null>(null);
  const repositories = Array.from(
    new Set(runs.map((run) => run.repository))
  ).sort((left, right) => left.localeCompare(right));
  const options: FleetFilterOptions = {
    query: search || undefined,
    repository: repositoryFilter === "all" ? undefined : repositoryFilter,
    lifecycle: lifecycleFilter === "all" ? undefined : lifecycleFilter,
  };
  const groups = filterAndGroupRuns(runs, options);
  const visibleRunCount = groups.reduce(
    (count, group) => count + group.runs.length,
    0
  );
  const effectiveConnectionState: ConnectionState = paused
    ? "paused"
    : connectionState;
  const isLive = dataSource.kind === "live-redacted";
  const connection = fleetConnectionPresentation(paused, isLive);

  const copyAttachCommand = (run: FleetRunDTO) => {
    const runtimeAttachable = run.adapters.some(
      (adapter) =>
        adapter.kind === "tmux" &&
        (adapter.state === "healthy" || adapter.state === "surviving")
    );
    if (!(VALIDATED_RUN_ID.test(run.runId) && runtimeAttachable)) {
      setCopyState({ runId: run.runId, status: "failed" });
      return;
    }

    const command = `loop attach --run-id ${run.runId}`;
    if (!navigator.clipboard) {
      setCopyState({ runId: run.runId, status: "failed" });
      return;
    }

    navigator.clipboard.writeText(command).then(
      () => setCopyState({ runId: run.runId, status: "copied" }),
      () => setCopyState({ runId: run.runId, status: "failed" })
    );
  };

  const clearFilters = () => {
    onSearchChange("");
    onRepositoryFilterChange("all");
    onLifecycleFilterChange("all");
  };

  return (
    <main className="fleet-view" id="main-content">
      <header className="fleet-header">
        <div className="fleet-heading-block">
          <p className="eyebrow">Loop control plane</p>
          <h1 id="fleet-heading">Run fleet</h1>
          <p className="fleet-intro">
            Triage durable paired-agent runs without changing runtime state.
          </p>
        </div>

        <div className="surface fleet-connection">
          <div
            aria-label={`Connection ${connection.label}`}
            className="fleet-connection-status"
            role="status"
          >
            <span
              aria-hidden="true"
              className={`status-dot status-${effectiveConnectionState}`}
            />
            <span className="fleet-connection-copy">
              <strong>{connection.label}</strong>
              <span>{connection.description}</span>
            </span>
            {paused && queuedUpdates > 0 ? (
              <span className="chip status-behind">{queuedUpdates} new</span>
            ) : null}
          </div>
          <button
            aria-pressed={paused}
            className="icon-button fleet-pause-button"
            onClick={() => onPausedChange(!paused)}
            type="button"
          >
            {paused ? "Resume updates" : "Pause updates"}
          </button>
        </div>
      </header>

      <aside aria-label="Read-only guidance" className="surface fleet-readonly">
        <div className="fleet-readonly-labels">
          <span className="chip">Read-only</span>
          <span className="chip fleet-demo-chip">
            {isLive ? "Live data" : "Demo data"}
          </span>
        </div>
        <div>
          <strong>
            {isLive
              ? "Harvto records connected, redacted at the server boundary."
              : "Synthetic fixture data, not a live runtime."}
          </strong>
          <p>
            {dataSource.notice} Agent input, cleanup, and runtime controls stay
            in the terminal.
          </p>
        </div>
      </aside>

      <section aria-label="Fleet filters" className="surface fleet-toolbar">
        <label className="fleet-search-field">
          <span>Search runs</span>
          <input
            onChange={(event) => onSearchChange(event.currentTarget.value)}
            placeholder="Repository, worktree, run ID, or title"
            type="search"
            value={search}
          />
        </label>

        <label className="fleet-filter-field">
          <span>Repository</span>
          <select
            onChange={(event) =>
              onRepositoryFilterChange(event.currentTarget.value)
            }
            value={repositoryFilter}
          >
            <option value="all">All repositories</option>
            {repositories.map((repository) => (
              <option key={repository} value={repository}>
                {repository}
              </option>
            ))}
          </select>
        </label>

        <label className="fleet-filter-field">
          <span>State</span>
          <select
            onChange={(event) =>
              onLifecycleFilterChange(
                event.currentTarget.value as RunLifecycle | "all"
              )
            }
            value={lifecycleFilter}
          >
            <option value="all">All states</option>
            {LIFECYCLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <div aria-live="polite" className="fleet-result-count">
          <strong>{visibleRunCount}</strong>
          <span>run{visibleRunCount === 1 ? "" : "s"} shown</span>
        </div>
      </section>

      {visibleRunCount === 0 ? (
        <section
          aria-labelledby="fleet-empty-heading"
          className="surface fleet-empty"
        >
          <span aria-hidden="true" className="fleet-empty-mark">
            0
          </span>
          <p className="eyebrow">Quiet fleet</p>
          <h2 id="fleet-empty-heading">
            {runs.length === 0
              ? "No persisted runs yet"
              : "No runs match these filters"}
          </h2>
          <p>
            {runs.length === 0
              ? "Start a paired run from the terminal. A valid manifest will appear here automatically."
              : "Clear the current search and filters to return to the complete fleet."}
          </p>
          {runs.length > 0 ? (
            <button
              className="icon-button"
              onClick={clearFilters}
              type="button"
            >
              Clear filters
            </button>
          ) : null}
        </section>
      ) : (
        <div className="fleet-groups">
          {groups.map((group) => (
            <section
              aria-labelledby={`fleet-group-${group.key}`}
              className={`fleet-group fleet-group-${group.key}`}
              key={group.key}
            >
              <header className="fleet-group-header">
                <div>
                  <h2 id={`fleet-group-${group.key}`}>{group.label}</h2>
                  <p>{GROUP_DESCRIPTIONS[group.key]}</p>
                </div>
                <span className={`chip status-${group.key}`}>
                  {group.runs.length}
                </span>
              </header>

              {group.runs.length > 0 ? (
                <div className="fleet-run-list">
                  {group.runs.map((run) => (
                    <RunCard
                      copyState={copyState}
                      group={group}
                      key={`${run.repoId}:${run.runId}`}
                      onCopyAttach={copyAttachCommand}
                      onSelectRun={onSelectRun}
                      run={run}
                    />
                  ))}
                </div>
              ) : (
                <p className="fleet-group-empty">No runs in this group.</p>
              )}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
