// biome-ignore-all lint/style/useFilenamingConvention: The reviewed component contract requires RunWorkspace.tsx.

import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AgentSeatDTO,
  EvidenceItemDTO,
  GovernessAuditDTO,
  GovernessDTO,
  OpaqueEvidenceId,
  ProvenanceDTO,
  RunDetailDTO,
  TimelineEventDTO,
  WorkerActivityDTO,
  WorkerTierDTO,
} from "../types";

interface RunWorkspaceProps {
  readonly onBack: () => void;
  readonly run: RunDetailDTO;
}

type AgentTab = "console" | "events" | "bridge";
type WorkspaceSection = "overview" | "agents" | "activity" | "timeline";
type TimelineCategory = TimelineEventDTO["category"] | "all";

const AGENT_TABS: readonly AgentTab[] = ["console", "events", "bridge"];
const WORKSPACE_SECTIONS: readonly WorkspaceSection[] = [
  "overview",
  "agents",
  "activity",
  "timeline",
];
const TIMELINE_CATEGORIES: readonly TimelineCategory[] = [
  "all",
  "lifecycle",
  "agent",
  "bridge",
  "governess",
  "worker",
  "evidence",
  "adapter",
];

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

const NUMBER_FORMAT = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown time"
    : DATE_FORMAT.format(date);
}

function formatAge(value: string): string {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return "age unknown";
  }

  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m ago`;
  }
  if (seconds < 86_400) {
    return `${Math.round(seconds / 3600)}h ago`;
  }
  return `${Math.round(seconds / 86_400)}d ago`;
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 1 ? 3 : 2,
    maximumFractionDigits: value < 1 ? 3 : 2,
  }).format(value);
}

function sentenceCase(value: string): string {
  return value
    .split("-")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function SourceMeta({ provenance }: { readonly provenance: ProvenanceDTO }) {
  return (
    <div className={`workspace-source workspace-source--${provenance.state}`}>
      <span className="workspace-source-kind">
        {sentenceCase(provenance.sourceKind)}
      </span>
      <span aria-hidden="true">·</span>
      <span>{provenance.sourceId}</span>
      <span aria-hidden="true">·</span>
      <span>{formatAge(provenance.observedAt)}</span>
      <span className="workspace-source-state">
        {sentenceCase(provenance.state)}
      </span>
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
}) {
  return (
    <div className="workspace-metric">
      <span className="workspace-metric-label">{label}</span>
      <strong className="workspace-metric-value">{value}</strong>
      {detail ? (
        <span className="workspace-metric-detail">{detail}</span>
      ) : null}
    </div>
  );
}

function AgentConsole({ agent }: { readonly agent: AgentSeatDTO }) {
  return (
    <div className="agent-console">
      <div className="agent-diagnostic-label">
        <span className="workspace-badge workspace-badge--diagnostic">
          Diagnostic projection
        </span>
        <span>Bounded and redacted. Terminal input is unavailable.</span>
      </div>
      <pre className="agent-console-tail">
        <code>{`[${formatDate(agent.lastHookAt)}] ${agent.lastHookEvent}\n[task] ${agent.currentTask}\n[model] ${agent.model} · ${agent.reasoningEffort}\n[tools] ${agent.toolsInFlight} in flight\n[status] ${agent.lifecycle}`}</code>
      </pre>
      <p className="workspace-muted">
        This preview is assembled from redacted public fields. It is not a raw
        provider transcript or an interactive shell.
      </p>
    </div>
  );
}

function AgentEvents({ agent }: { readonly agent: AgentSeatDTO }) {
  return (
    <div className="agent-events">
      <article className="agent-event agent-event--latest">
        <div aria-hidden="true" className="agent-event-marker" />
        <div>
          <div className="agent-event-heading">
            <strong>{agent.lastHookEvent}</strong>
            <time dateTime={agent.lastHookAt}>
              {formatDate(agent.lastHookAt)}
            </time>
          </div>
          <p>Latest normalized hook event</p>
        </div>
      </article>
      {agent.provenance.map((provenance) => (
        <article
          className="agent-event"
          key={`${provenance.sourceId}-${provenance.revision}`}
        >
          <div aria-hidden="true" className="agent-event-marker" />
          <div>
            <div className="agent-event-heading">
              <strong>{sentenceCase(provenance.sourceKind)}</strong>
              <time dateTime={provenance.observedAt}>
                {formatDate(provenance.observedAt)}
              </time>
            </div>
            <p>{provenance.note ?? `Revision ${provenance.revision}`}</p>
            <SourceMeta provenance={provenance} />
          </div>
        </article>
      ))}
    </div>
  );
}

function AgentBridge({ agent }: { readonly agent: AgentSeatDTO }) {
  const message = agent.latestBridgeMessage;
  if (!message) {
    return (
      <div className="agent-empty-state">
        <span aria-hidden="true" className="workspace-empty-icon">
          ↔
        </span>
        <strong>No bridge message in this snapshot</strong>
        <p>
          Absence is displayed as unknown activity, not proof of an idle peer.
        </p>
      </div>
    );
  }

  return (
    <article
      className={`agent-bridge-message agent-bridge-message--${message.status}`}
    >
      <div className="agent-bridge-heading">
        <span className="workspace-badge workspace-badge--subtle">
          {sentenceCase(message.direction)}
        </span>
        <span
          className={`workspace-status workspace-status--${message.status}`}
        >
          {sentenceCase(message.status)}
        </span>
        <time dateTime={message.at}>{formatDate(message.at)}</time>
      </div>
      <p>{message.summary}</p>
      <div className="agent-diagnostic-label">
        <span className="workspace-badge workspace-badge--diagnostic">
          Redacted summary
        </span>
        <span>Durable delivery state only</span>
      </div>
    </article>
  );
}

function EmptyAgentSeat({ index }: { readonly index: number }) {
  return (
    <article className="agent-seat agent-seat--empty">
      <header className="agent-seat-header">
        <div>
          <span className="workspace-eyebrow">
            Frontier agent seat {index + 1}
          </span>
          <h2>Seat unavailable</h2>
        </div>
        <span className="workspace-status workspace-status--unknown">
          Unknown
        </span>
      </header>
      <div className="agent-empty-state">
        <strong>No authoritative agent record</strong>
        <p>
          This seat remains visible so missing evidence cannot look like a
          healthy pair.
        </p>
      </div>
    </article>
  );
}

function AgentSeat({
  agent,
  activeTab,
  onTabChange,
  index,
}: {
  readonly agent: AgentSeatDTO;
  readonly activeTab: AgentTab;
  readonly onTabChange: (tab: AgentTab) => void;
  readonly index: number;
}) {
  const totalTokens =
    agent.usage.inputTokens +
    agent.usage.outputTokens +
    agent.usage.cachedTokens;
  const tabPrefix = `agent-${agent.id}`;

  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentTab: AgentTab
  ) => {
    const currentIndex = AGENT_TABS.indexOf(currentTab);
    let nextTab: AgentTab | undefined;

    if (event.key === "ArrowRight") {
      nextTab = AGENT_TABS[(currentIndex + 1) % AGENT_TABS.length];
    } else if (event.key === "ArrowLeft") {
      nextTab =
        AGENT_TABS[(currentIndex - 1 + AGENT_TABS.length) % AGENT_TABS.length];
    } else if (event.key === "Home") {
      nextTab = AGENT_TABS[0];
    } else if (event.key === "End") {
      nextTab = AGENT_TABS.at(-1);
    }

    if (!nextTab) {
      return;
    }

    event.preventDefault();
    onTabChange(nextTab);
    document.getElementById(`${tabPrefix}-${nextTab}-tab`)?.focus();
  };

  return (
    <article className={`agent-seat agent-seat--${agent.lifecycle}`}>
      <header className="agent-seat-header">
        <div className="agent-identity">
          <span className="workspace-eyebrow">
            Frontier agent seat {index + 1}
          </span>
          <div className="agent-title-row">
            <h2>{agent.displayName}</h2>
            <span className="workspace-badge workspace-badge--role">
              {sentenceCase(agent.role)}
            </span>
          </div>
          <p>
            {agent.provider} · {agent.model} · {agent.reasoningEffort}
          </p>
        </div>
        <div className="agent-lifecycle">
          <span
            className={`workspace-status workspace-status--${agent.lifecycle}`}
          >
            <span aria-hidden="true" className="workspace-status-dot" />
            {sentenceCase(agent.lifecycle)}
          </span>
          <span>{formatAge(agent.lastHookAt)}</span>
        </div>
      </header>

      <section
        aria-label={`${agent.displayName} current task`}
        className="agent-current-task"
      >
        <div className="agent-task-heading">
          <span className="workspace-eyebrow">Current task</span>
          <span className="workspace-badge workspace-badge--advisory">
            Advisory
          </span>
        </div>
        <p>{agent.currentTask}</p>
        <span>
          Source: {agent.taskSource} · observed{" "}
          {formatAge(agent.taskObservedAt)}
        </span>
      </section>

      <div className="agent-metrics">
        <div className="agent-context-metric">
          <div className="agent-context-heading">
            <span>Context</span>
            <strong>{agent.usage.contextPercent}%</strong>
          </div>
          <div
            aria-label={`${agent.usage.contextPercent}% context used`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={agent.usage.contextPercent}
            className="agent-context-track"
            role="progressbar"
          >
            <span
              className="agent-context-fill"
              style={{
                width: `${Math.min(100, Math.max(0, agent.usage.contextPercent))}%`,
              }}
            />
          </div>
          <span>{agent.usage.compactions} compactions</span>
        </div>
        <Metric
          detail={`${NUMBER_FORMAT.format(agent.usage.cachedTokens)} cached`}
          label="Tokens"
          value={NUMBER_FORMAT.format(totalTokens)}
        />
        <Metric
          detail="cumulative"
          label="Cost"
          value={formatMoney(agent.usage.costUsd)}
        />
        <Metric
          detail="in flight"
          label="Tools"
          value={String(agent.toolsInFlight)}
        />
      </div>

      {agent.usage.windows.length > 0 ? (
        <section aria-label="Quota windows" className="agent-quota-list">
          {agent.usage.windows.map((window) => (
            <article
              aria-label={`${sentenceCase(window.kind)} quota, ${window.usedPercent}% used`}
              className="agent-quota"
              key={window.kind}
            >
              <div>
                <span>{sentenceCase(window.kind)} limit</span>
                <strong>{window.usedPercent}% used</strong>
              </div>
              <span className="agent-quota-source">
                {sentenceCase(window.provenance.sourceKind)} ·{" "}
                {sentenceCase(window.provenance.state)}
              </span>
              <div aria-hidden="true" className="agent-quota-track">
                <span
                  style={{
                    width: `${Math.min(100, Math.max(0, window.usedPercent))}%`,
                  }}
                />
              </div>
              <span>
                Reset{" "}
                {window.resetState === "known" && window.resetAt
                  ? formatDate(window.resetAt)
                  : window.resetState}
              </span>
            </article>
          ))}
        </section>
      ) : (
        <div className="agent-quota agent-quota--unknown">
          Quota window unsupported or unknown
        </div>
      )}

      <div
        aria-label={`${agent.displayName} detail views`}
        className="agent-tabs"
        role="tablist"
      >
        {AGENT_TABS.map((tab) => (
          <button
            aria-controls={`${tabPrefix}-${tab}-panel`}
            aria-selected={activeTab === tab}
            className={`agent-tab ${activeTab === tab ? "agent-tab--active" : ""}`}
            id={`${tabPrefix}-${tab}-tab`}
            key={tab}
            onClick={() => onTabChange(tab)}
            onKeyDown={(event) => handleTabKeyDown(event, tab)}
            role="tab"
            tabIndex={activeTab === tab ? 0 : -1}
            type="button"
          >
            {sentenceCase(tab)}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={`${tabPrefix}-${activeTab}-tab`}
        className="agent-tab-panel"
        id={`${tabPrefix}-${activeTab}-panel`}
        role="tabpanel"
      >
        {activeTab === "console" ? <AgentConsole agent={agent} /> : null}
        {activeTab === "events" ? <AgentEvents agent={agent} /> : null}
        {activeTab === "bridge" ? <AgentBridge agent={agent} /> : null}
      </div>
    </article>
  );
}

function EvidenceButton({
  evidenceId,
  onOpen,
  compact = false,
}: {
  readonly evidenceId: OpaqueEvidenceId;
  readonly onOpen: (evidenceId: OpaqueEvidenceId) => void;
  readonly compact?: boolean;
}) {
  return (
    <button
      className={`evidence-link ${compact ? "evidence-link--compact" : ""}`}
      onClick={() => onOpen(evidenceId)}
      type="button"
    >
      <span aria-hidden="true">⌁</span>
      <span>{compact ? "Evidence" : evidenceId}</span>
    </button>
  );
}

function GovernessAuditRow({
  entry,
  onOpenEvidence,
}: {
  readonly entry: GovernessAuditDTO;
  readonly onOpenEvidence: (evidenceId: OpaqueEvidenceId) => void;
}) {
  return (
    <tr>
      <td>
        <strong>{entry.phase}</strong>
        <span>{entry.controlId}</span>
      </td>
      <td>{entry.transport}</td>
      <td>{entry.acknowledgement}</td>
      <td>
        <time dateTime={entry.at}>{formatDate(entry.at)}</time>
      </td>
      <td>
        <EvidenceButton
          compact
          evidenceId={entry.evidenceId}
          onOpen={onOpenEvidence}
        />
      </td>
    </tr>
  );
}

function GovernessPanel({
  governess,
  onOpenEvidence,
}: {
  readonly governess: GovernessDTO;
  readonly onOpenEvidence: (evidenceId: OpaqueEvidenceId) => void;
}) {
  return (
    <article className="governess-panel">
      <header className="governess-header">
        <div>
          <span className="workspace-eyebrow">
            Deterministic control authority
          </span>
          <h2>Governess</h2>
          <p>
            Epoch {governess.epoch} · lease {governess.driverLease}
          </p>
        </div>
        <span className="workspace-badge workspace-badge--readonly">
          Read-only release
        </span>
      </header>

      <section className="governess-section governess-facts">
        <div className="governess-section-heading">
          <div>
            <span className="workspace-eyebrow">Durable state</span>
            <h3>Facts</h3>
          </div>
          <span className="workspace-badge workspace-badge--fact">
            Authoritative
          </span>
        </div>
        <div className="governess-fact-grid">
          {governess.facts.map((fact) => (
            <article
              className={`governess-fact governess-fact--${fact.status}`}
              key={fact.label}
            >
              <span>{fact.label}</span>
              <strong>{fact.value}</strong>
              <SourceMeta provenance={fact.provenance} />
            </article>
          ))}
        </div>
      </section>

      <section className="governess-section governess-interpretation">
        <div className="governess-section-heading">
          <div>
            <span className="workspace-eyebrow">Model-assisted reading</span>
            <h3>Interpretation</h3>
          </div>
          <span className="workspace-badge workspace-badge--advisory">
            Advisory only
          </span>
        </div>
        <div className="governess-interpretation-list">
          {governess.interpretations.map((interpretation) => (
            <article
              className="governess-interpretation-card"
              key={`${interpretation.kind}-${interpretation.generatedAt}`}
            >
              <div>
                <span>{sentenceCase(interpretation.kind)}</span>
                <strong>
                  {Math.round(interpretation.confidence * 100)}% confidence
                </strong>
              </div>
              <p>{interpretation.summary}</p>
              <footer>
                {interpretation.source} · generated{" "}
                {formatAge(interpretation.generatedAt)}
              </footer>
            </article>
          ))}
        </div>
      </section>

      <section className="governess-section governess-policy">
        <div className="governess-section-heading">
          <div>
            <span className="workspace-eyebrow">Policy projection</span>
            <h3>Policy and planned actions</h3>
          </div>
          <span className="workspace-badge workspace-badge--readonly">
            No actions available
          </span>
        </div>
        <div className="governess-policy-list">
          {governess.policies.map((policy) => (
            <article
              className={`governess-policy-card governess-policy-card--${policy.disposition}`}
              key={policy.title}
            >
              <div>
                <span
                  className={`workspace-status workspace-status--${policy.disposition}`}
                >
                  {sentenceCase(policy.disposition)}
                </span>
                <span>{policy.releaseLabel}</span>
              </div>
              <h4>{policy.title}</h4>
              <p>{policy.reason}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="governess-section governess-audit">
        <div className="governess-section-heading">
          <div>
            <span className="workspace-eyebrow">Durable controls</span>
            <h3>Audit</h3>
          </div>
          <span>{governess.audit.length} records</span>
        </div>
        <div className="governess-audit-scroll">
          <table className="governess-audit-table">
            <thead>
              <tr>
                <th scope="col">Control</th>
                <th scope="col">Transport</th>
                <th scope="col">Acknowledgement</th>
                <th scope="col">Observed</th>
                <th scope="col">Record</th>
              </tr>
            </thead>
            <tbody>
              {governess.audit.map((entry) => (
                <GovernessAuditRow
                  entry={entry}
                  key={entry.controlId}
                  onOpenEvidence={onOpenEvidence}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </article>
  );
}

function WorkerActivity({
  activity,
  expanded,
  onToggle,
  onOpenEvidence,
}: {
  readonly activity: WorkerActivityDTO;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOpenEvidence: (evidenceId: OpaqueEvidenceId) => void;
}) {
  return (
    <article className={`worker-job worker-job--${activity.state}`}>
      <button
        aria-expanded={expanded}
        className="worker-job-summary"
        onClick={onToggle}
        type="button"
      >
        <span
          className={`workspace-status workspace-status--${activity.state}`}
        >
          {sentenceCase(activity.state)}
        </span>
        <span className="worker-job-request">
          <strong>{activity.requestSummary}</strong>
          <small>{activity.routingReason}</small>
        </span>
        <span className="worker-job-time">{formatAge(activity.startedAt)}</span>
        <span aria-hidden="true" className="worker-job-chevron">
          {expanded ? "−" : "+"}
        </span>
      </button>
      {expanded ? (
        <div className="worker-job-detail">
          <fieldset className="worker-flow">
            <legend className="workspace-visually-hidden">
              Bounded worker flow
            </legend>
            <div>
              <span>Request</span>
              <p>{activity.requestSummary}</p>
            </div>
            <span aria-hidden="true">→</span>
            <div>
              <span>Tool activity</span>
              <p>{activity.toolSummary}</p>
            </div>
            <span aria-hidden="true">→</span>
            <div>
              <span>{activity.state === "failed" ? "Blocker" : "Result"}</span>
              <p>{activity.resultSummary}</p>
            </div>
          </fieldset>
          <div className="worker-job-metrics">
            <Metric label="Model calls" value={String(activity.modelCalls)} />
            <Metric
              label="Tokens"
              value={NUMBER_FORMAT.format(activity.tokens)}
            />
            <Metric label="Cost" value={formatMoney(activity.costUsd)} />
            <Metric
              label="Finished"
              value={
                activity.finishedAt
                  ? formatAge(activity.finishedAt)
                  : "In progress"
              }
            />
          </div>
          <div className="worker-context">
            <span className="workspace-eyebrow">Bounded context capsule</span>
            <p>{activity.contextCapsule}</p>
          </div>
          {activity.artifactEvidenceIds.length > 0 ? (
            <div className="worker-artifacts">
              <span>Artifact references</span>
              {activity.artifactEvidenceIds.map((evidenceId) => (
                <EvidenceButton
                  evidenceId={evidenceId}
                  key={evidenceId}
                  onOpen={onOpenEvidence}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function WorkerTierPanel({
  tier,
  expandedActivity,
  onToggleActivity,
  onOpenEvidence,
}: {
  readonly tier: WorkerTierDTO;
  readonly expandedActivity: string | null;
  readonly onToggleActivity: (activityId: string) => void;
  readonly onOpenEvidence: (evidenceId: OpaqueEvidenceId) => void;
}) {
  return (
    <section className={`worker-tier worker-tier--${tier.tier}`}>
      <header className="worker-tier-header">
        <div>
          <h3>{tier.label}</h3>
          <p>{tier.description}</p>
        </div>
        <span className="workspace-badge workspace-badge--subordinate">
          Execution tier
        </span>
      </header>
      <fieldset className="worker-counts">
        <legend className="workspace-visually-hidden">
          {tier.label} job counts
        </legend>
        <span>
          <strong>{tier.counts.queued}</strong> queued
        </span>
        <span>
          <strong>{tier.counts.active}</strong> active
        </span>
        <span>
          <strong>{tier.counts.completed}</strong> completed
        </span>
        <span className={tier.counts.failed > 0 ? "worker-count--failed" : ""}>
          <strong>{tier.counts.failed}</strong> failed
        </span>
      </fieldset>
      <div className="worker-job-list">
        {tier.activity.length > 0 ? (
          tier.activity.map((activity) => (
            <WorkerActivity
              activity={activity}
              expanded={expandedActivity === activity.id}
              key={activity.id}
              onOpenEvidence={onOpenEvidence}
              onToggle={() => onToggleActivity(activity.id)}
            />
          ))
        ) : (
          <div className="worker-empty-state">
            No activity in this projection.
          </div>
        )}
      </div>
    </section>
  );
}

function WorkerPanel({
  workers,
  expandedActivity,
  onToggleActivity,
  onOpenEvidence,
}: {
  readonly workers: readonly WorkerTierDTO[];
  readonly expandedActivity: string | null;
  readonly onToggleActivity: (activityId: string) => void;
  readonly onOpenEvidence: (evidenceId: OpaqueEvidenceId) => void;
}) {
  const totals = workers.reduce(
    (sum, worker) => ({
      queued: sum.queued + worker.counts.queued,
      active: sum.active + worker.counts.active,
      completed: sum.completed + worker.counts.completed,
      failed: sum.failed + worker.counts.failed,
    }),
    { queued: 0, active: 0, completed: 0, failed: 0 }
  );

  return (
    <article className="worker-panel">
      <header className="worker-panel-header">
        <div>
          <span className="workspace-eyebrow">Governess-routed execution</span>
          <h2>Bounded worker activity</h2>
          <p>
            Direct, Nanny, and Au Pair are execution tiers, not peer agents.
          </p>
        </div>
        <span className="workspace-badge workspace-badge--diagnostic">
          Read-only activity
        </span>
      </header>
      <div className="worker-summary-strip">
        <Metric label="Queued" value={String(totals.queued)} />
        <Metric label="Active" value={String(totals.active)} />
        <Metric label="Completed" value={String(totals.completed)} />
        <Metric label="Failed" value={String(totals.failed)} />
      </div>
      <div className="worker-tier-list">
        {workers.map((tier) => (
          <WorkerTierPanel
            expandedActivity={expandedActivity}
            key={tier.tier}
            onOpenEvidence={onOpenEvidence}
            onToggleActivity={onToggleActivity}
            tier={tier}
          />
        ))}
      </div>
    </article>
  );
}

function TimelineRow({
  event,
  onOpenEvidence,
}: {
  readonly event: TimelineEventDTO;
  readonly onOpenEvidence: (evidenceId: OpaqueEvidenceId) => void;
}) {
  return (
    <article className={`timeline-row timeline-row--${event.tone}`}>
      <div aria-hidden="true" className="timeline-rail">
        <span className="timeline-dot" />
        <span className="timeline-line" />
      </div>
      <div className="timeline-content">
        <header className="timeline-row-header">
          <div>
            <span
              className={`workspace-badge workspace-badge--${event.category}`}
            >
              {sentenceCase(event.category)}
            </span>
            <span className="timeline-sequence">#{event.sequence}</span>
            <span className="timeline-actor">{event.actor}</span>
          </div>
          <time dateTime={event.at}>{formatDate(event.at)}</time>
        </header>
        <h3>{event.title}</h3>
        <p>{event.detail}</p>
        <footer className="timeline-row-footer">
          <SourceMeta provenance={event.provenance} />
          <div className="timeline-evidence-links">
            {event.evidenceIds.map((evidenceId) => (
              <EvidenceButton
                compact
                evidenceId={evidenceId}
                key={evidenceId}
                onOpen={onOpenEvidence}
              />
            ))}
          </div>
        </footer>
      </div>
    </article>
  );
}

function TimelinePanel({
  events,
  category,
  query,
  onCategoryChange,
  onQueryChange,
  onOpenEvidence,
}: {
  readonly events: readonly TimelineEventDTO[];
  readonly category: TimelineCategory;
  readonly query: string;
  readonly onCategoryChange: (category: TimelineCategory) => void;
  readonly onQueryChange: (query: string) => void;
  readonly onOpenEvidence: (evidenceId: OpaqueEvidenceId) => void;
}) {
  const filteredEvents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return events.filter((event) => {
      const matchesCategory = category === "all" || event.category === category;
      const matchesQuery =
        normalizedQuery.length === 0 ||
        [event.id, event.actor, event.title, event.detail].some((value) =>
          value.toLowerCase().includes(normalizedQuery)
        );
      return matchesCategory && matchesQuery;
    });
  }, [category, events, query]);

  return (
    <article className="timeline-panel">
      <header className="timeline-header">
        <div>
          <span className="workspace-eyebrow">Combined durable history</span>
          <h2>Timeline</h2>
          <p>
            Lifecycle, agents, bridge, Governess, workers, evidence, and
            adapters.
          </p>
        </div>
        <div className="timeline-page-state">
          <span className="workspace-badge workspace-badge--live">
            Newest page
          </span>
          <span>
            {filteredEvents.length} of {events.length} events
          </span>
        </div>
      </header>

      <div className="timeline-filters">
        <label className="timeline-search">
          <span className="workspace-visually-hidden">Search timeline</span>
          <span aria-hidden="true">⌕</span>
          <input
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Filter events"
            type="search"
            value={query}
          />
        </label>
        <fieldset className="timeline-category-filters">
          <legend className="workspace-visually-hidden">
            Timeline categories
          </legend>
          {TIMELINE_CATEGORIES.map((option) => (
            <button
              aria-pressed={category === option}
              className={category === option ? "timeline-filter--active" : ""}
              key={option}
              onClick={() => onCategoryChange(option)}
              type="button"
            >
              {sentenceCase(option)}
            </button>
          ))}
        </fieldset>
      </div>

      <div className="timeline-list">
        {filteredEvents.length > 0 ? (
          filteredEvents.map((event) => (
            <TimelineRow
              event={event}
              key={event.id}
              onOpenEvidence={onOpenEvidence}
            />
          ))
        ) : (
          <div className="timeline-empty-state">
            <strong>No events match these filters</strong>
            <p>
              Change the category or query. The underlying timeline has not been
              altered.
            </p>
          </div>
        )}
      </div>

      <nav aria-label="Timeline pages" className="timeline-pagination">
        <button disabled type="button">
          ← Newer
        </button>
        <span>Newest bounded snapshot · maximum 100 rows</span>
        <button disabled type="button">
          Older →
        </button>
      </nav>
    </article>
  );
}

function EvidenceDrawer({
  drawerRef,
  evidence,
  onClose,
  requestedId,
}: {
  readonly drawerRef: RefObject<HTMLDivElement | null>;
  readonly evidence?: EvidenceItemDTO;
  readonly onClose: () => void;
  readonly requestedId: OpaqueEvidenceId;
}) {
  return (
    <div
      aria-labelledby="evidence-drawer-title"
      aria-modal="true"
      className="evidence-drawer"
      ref={drawerRef}
      role="dialog"
      tabIndex={-1}
    >
      <header className="evidence-drawer-header">
        <div>
          <span className="workspace-eyebrow">Opaque evidence reference</span>
          <h2 id="evidence-drawer-title">
            {evidence?.title ?? "Evidence unavailable"}
          </h2>
        </div>
        <button
          aria-label="Close evidence drawer"
          onClick={onClose}
          type="button"
        >
          ×
        </button>
      </header>
      {evidence ? (
        <div className="evidence-drawer-content">
          <div className="evidence-id-row">
            <code>{evidence.id}</code>
            <span
              className={`workspace-badge workspace-badge--${evidence.kind}`}
            >
              {sentenceCase(evidence.kind)}
            </span>
          </div>
          <div className="evidence-preview">
            <span className="workspace-badge workspace-badge--diagnostic">
              Metadata-only preview
            </span>
            <p>{evidence.summary}</p>
          </div>
          <dl className="evidence-metadata">
            <div>
              <dt>Captured</dt>
              <dd>{formatDate(evidence.capturedAt)}</dd>
            </div>
            <div>
              <dt>Media type</dt>
              <dd>{evidence.mimeType}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{NUMBER_FORMAT.format(evidence.byteCount)} bytes</dd>
            </div>
            <div>
              <dt>Redactions</dt>
              <dd>{evidence.redactionsApplied}</dd>
            </div>
          </dl>
          <SourceMeta provenance={evidence.provenance} />
          <div className="evidence-boundary-note">
            <strong>Containment boundary</strong>
            <p>
              This browser projection exposes an opaque identifier and redacted
              metadata only. It does not reveal a local path or unrestricted
              file contents.
            </p>
          </div>
        </div>
      ) : (
        <div className="evidence-drawer-content evidence-drawer-content--missing">
          <code>{requestedId}</code>
          <strong>No matching evidence record in this snapshot</strong>
          <p>
            Missing evidence remains visible and does not resolve to an
            arbitrary path.
          </p>
        </div>
      )}
    </div>
  );
}

export function RunWorkspace({ run, onBack }: RunWorkspaceProps) {
  const [activeSection, setActiveSection] =
    useState<WorkspaceSection>("agents");
  const [agentTabs, setAgentTabs] = useState<Record<string, AgentTab>>({});
  const [timelineCategory, setTimelineCategory] =
    useState<TimelineCategory>("all");
  const [timelineQuery, setTimelineQuery] = useState("");
  const [expandedActivity, setExpandedActivity] = useState<string | null>(
    run.workers.flatMap((worker) => worker.activity)[0]?.id ?? null
  );
  const [selectedEvidenceId, setSelectedEvidenceId] =
    useState<OpaqueEvidenceId | null>(null);
  const evidenceDrawerRef = useRef<HTMLDivElement>(null);
  const evidenceReturnFocusRef = useRef<HTMLElement | null>(null);

  const selectedEvidence = selectedEvidenceId
    ? run.evidence.find((item) => item.id === selectedEvidenceId)
    : undefined;
  const agentSeats: readonly {
    readonly agent: AgentSeatDTO | undefined;
    readonly index: number;
    readonly slot: "first" | "second";
  }[] = [
    { agent: run.agents[0], index: 0, slot: "first" },
    { agent: run.agents[1], index: 1, slot: "second" },
  ];

  const navigateToSection = (section: WorkspaceSection) => {
    setActiveSection(section);
    document.getElementById(`workspace-${section}`)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  const setAgentTab = (agentId: string, tab: AgentTab) => {
    setAgentTabs((current) => ({ ...current, [agentId]: tab }));
  };

  const openEvidence = (evidenceId: OpaqueEvidenceId) => {
    evidenceReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setSelectedEvidenceId(evidenceId);
  };

  const closeEvidence = useCallback(() => {
    const returnTarget = evidenceReturnFocusRef.current;
    setSelectedEvidenceId(null);
    evidenceReturnFocusRef.current = null;
    window.requestAnimationFrame(() => {
      if (returnTarget?.isConnected) {
        returnTarget.focus();
      }
    });
  }, []);

  useEffect(() => {
    if (!selectedEvidenceId) {
      return;
    }

    const drawer = evidenceDrawerRef.current;
    drawer?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeEvidence();
        return;
      }

      if (event.key !== "Tab" || !drawer) {
        return;
      }

      const focusable = Array.from(
        drawer.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
        )
      );

      if (focusable.length === 0) {
        event.preventDefault();
        drawer.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable.at(-1);
      const activeElement = document.activeElement;

      if (
        event.shiftKey &&
        (activeElement === first || activeElement === drawer)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeEvidence, selectedEvidenceId]);

  const toggleActivity = (activityId: string) => {
    setExpandedActivity((current) =>
      current === activityId ? null : activityId
    );
  };

  return (
    <div className={`workspace-shell workspace-shell--${run.quality.severity}`}>
      <header className="workspace-authority-header">
        <div className="workspace-header-topline">
          <button
            className="workspace-back-button"
            onClick={onBack}
            type="button"
          >
            <span aria-hidden="true">←</span>
            Fleet
          </button>
          <div className="workspace-title-block">
            <span className="workspace-eyebrow">{run.summary.repository}</span>
            <h1>{run.summary.title}</h1>
            <p>{run.summary.worktree}</p>
          </div>
          <div className="workspace-header-badges">
            <span className="workspace-badge workspace-badge--readonly">
              Read-only release
            </span>
            <span
              className={`workspace-status workspace-status--${run.summary.lifecycle}`}
            >
              <span aria-hidden="true" className="workspace-status-dot" />
              {sentenceCase(run.summary.lifecycle)}
            </span>
          </div>
        </div>

        <div className="workspace-authority-strip">
          <div>
            <span>Run ID</span>
            <strong>{run.authority.runId}</strong>
          </div>
          <div>
            <span>Current driver</span>
            <strong>{run.authority.currentDriver}</strong>
          </div>
          <div>
            <span>Governess epoch</span>
            <strong>{run.authority.epoch}</strong>
          </div>
          <div>
            <span>Authority lease</span>
            <strong className={`workspace-value--${run.authority.leaseState}`}>
              {sentenceCase(run.authority.leaseState)}
            </strong>
          </div>
          <div>
            <span>Data quality</span>
            <strong className={`workspace-value--${run.quality.severity}`}>
              {run.quality.label}
            </strong>
          </div>
          <div>
            <span>Connection</span>
            <strong className={`workspace-value--${run.connection.state}`}>
              {run.connection.label}
            </strong>
          </div>
          <div>
            <span>Last observed</span>
            <strong>{formatAge(run.connection.lastObservedAt)}</strong>
          </div>
        </div>

        <div
          className={`workspace-quality-banner workspace-quality-banner--${run.quality.severity}`}
        >
          <div>
            <strong>{run.quality.summary}</strong>
            <span>{run.fixtureSource.notice}</span>
          </div>
          <span className="workspace-badge workspace-badge--fixture">
            {sentenceCase(run.fixtureSource.kind)} ·{" "}
            {run.fixtureSource.scenario}
          </span>
        </div>
      </header>

      <section
        aria-label="Persistent run authority"
        className="workspace-mobile-authority"
      >
        <div>
          <span>Run</span>
          <strong title={run.authority.runId}>{run.authority.runId}</strong>
        </div>
        <div>
          <span>Driver</span>
          <strong title={run.authority.currentDriver}>
            {run.authority.currentDriver}
          </strong>
        </div>
        <div>
          <span>Epoch</span>
          <strong title={run.authority.epoch}>{run.authority.epoch}</strong>
        </div>
        <div>
          <span>Quality</span>
          <strong className={`workspace-value--${run.quality.severity}`}>
            {run.quality.label}
          </strong>
        </div>
      </section>

      <nav
        aria-label="Run workspace sections"
        className="workspace-section-nav"
      >
        {WORKSPACE_SECTIONS.map((section) => (
          <button
            aria-current={activeSection === section ? "page" : undefined}
            className={
              activeSection === section ? "workspace-section-nav--active" : ""
            }
            key={section}
            onClick={() => navigateToSection(section)}
            type="button"
          >
            {sentenceCase(section)}
          </button>
        ))}
      </nav>

      <main className="workspace-main">
        <section
          className="workspace-section workspace-agents"
          id="workspace-agents"
        >
          <div className="workspace-section-intro">
            <div>
              <span className="workspace-eyebrow">Paired frontier roles</span>
              <h2>Agents</h2>
            </div>
            <p>
              Two peer seats. Lifecycle is factual; task labels are advisory.
            </p>
          </div>
          <div className="workspace-agent-grid">
            {agentSeats.map((seat) => {
              const agent = seat.agent;
              return agent ? (
                <AgentSeat
                  activeTab={agentTabs[agent.id] ?? "console"}
                  agent={agent}
                  index={seat.index}
                  key={agent.id}
                  onTabChange={(tab) => setAgentTab(agent.id, tab)}
                />
              ) : (
                <EmptyAgentSeat
                  index={seat.index}
                  key={`empty-seat-${seat.slot}`}
                />
              );
            })}
          </div>
        </section>

        <div className="workspace-operations-grid">
          <section
            className="workspace-section workspace-overview"
            id="workspace-overview"
          >
            <GovernessPanel
              governess={run.governess}
              onOpenEvidence={openEvidence}
            />
          </section>
          <section
            className="workspace-section workspace-activity"
            id="workspace-activity"
          >
            <WorkerPanel
              expandedActivity={expandedActivity}
              onOpenEvidence={openEvidence}
              onToggleActivity={toggleActivity}
              workers={run.workers}
            />
          </section>
        </div>

        <section
          className="workspace-section workspace-timeline"
          id="workspace-timeline"
        >
          <TimelinePanel
            category={timelineCategory}
            events={run.timeline}
            onCategoryChange={setTimelineCategory}
            onOpenEvidence={openEvidence}
            onQueryChange={setTimelineQuery}
            query={timelineQuery}
          />
        </section>
      </main>

      {selectedEvidenceId ? (
        <>
          <button
            aria-label="Close evidence drawer"
            className="evidence-backdrop"
            onClick={closeEvidence}
            type="button"
          />
          <EvidenceDrawer
            drawerRef={evidenceDrawerRef}
            evidence={selectedEvidence}
            onClose={closeEvidence}
            requestedId={selectedEvidenceId}
          />
        </>
      ) : null}
    </div>
  );
}
