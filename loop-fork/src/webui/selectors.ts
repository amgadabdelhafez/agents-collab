import type {
  FleetFilterOptions,
  FleetGroupKey,
  FleetRunDTO,
  FleetRunGroupDTO,
  ReasonSeverity,
  RunLifecycle,
  RunReasonCode,
} from "./types";

const GROUPS: readonly Omit<FleetRunGroupDTO, "runs">[] = [
  { key: "needs-attention", label: "Needs attention" },
  { key: "cleanup-debt", label: "Cleanup debt" },
  { key: "active", label: "Active" },
  { key: "finished", label: "Finished" },
];

const ATTENTION_REASONS = new Set<RunReasonCode>([
  "input-required",
  "failed-control",
  "stale-authority",
  "corrupt-evidence",
  "identity-conflict",
]);

const CLEANUP_REASONS = new Set<RunReasonCode>([
  "surviving-adapter",
  "active-looking-manifest",
]);

const ACTIVE_LIFECYCLES = new Set<RunLifecycle>([
  "submitted",
  "working",
  "reviewing",
]);

const SEVERITY_RANK: Readonly<Record<ReasonSeverity, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const asArray = <T>(value: T | readonly T[] | undefined): readonly T[] => {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value as T];
};

const compareText = (left: string, right: string): number => {
  const normalizedLeft = left.toLocaleLowerCase("en-US");
  const normalizedRight = right.toLocaleLowerCase("en-US");
  if (normalizedLeft === normalizedRight) {
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  }
  return normalizedLeft < normalizedRight ? -1 : 1;
};

const eventTime = (run: FleetRunDTO): number => {
  const parsed = Date.parse(run.lastDurableEventAt);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const highestReasonRank = (run: FleetRunDTO): number =>
  run.reasons.reduce(
    (highest, reason) => Math.max(highest, SEVERITY_RANK[reason.severity]),
    0
  );

const compareRuns = (left: FleetRunDTO, right: FleetRunDTO): number => {
  const severityDifference = highestReasonRank(right) - highestReasonRank(left);
  if (severityDifference !== 0) {
    return severityDifference;
  }

  const eventDifference = eventTime(right) - eventTime(left);
  if (eventDifference !== 0) {
    return eventDifference;
  }

  const repositoryDifference = compareText(left.repository, right.repository);
  if (repositoryDifference !== 0) {
    return repositoryDifference;
  }

  const runIdDifference = compareText(left.runId, right.runId);
  return runIdDifference || compareText(left.routeId, right.routeId);
};

const includesOneOf = <T>(value: T, options: readonly T[]): boolean =>
  options.length === 0 || options.includes(value);

const matchesSearch = (run: FleetRunDTO, query: string): boolean => {
  const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
  if (!normalizedQuery) {
    return true;
  }

  const searchable = [
    run.runId,
    run.routeId,
    run.repoId,
    run.repository,
    run.worktree,
    run.title,
    run.lifecycle,
    run.driver,
    run.reviewer,
    ...run.reasons.flatMap((reason) => [
      reason.code,
      reason.label,
      reason.detail,
    ]),
    ...run.agents.flatMap((agent) => [
      agent.id,
      agent.displayName,
      agent.role,
      agent.lifecycle,
    ]),
  ];

  return searchable.some((value) =>
    value.toLocaleLowerCase("en-US").includes(normalizedQuery)
  );
};

/** Resolve the one canonical fleet group using the normative precedence. */
export const getPrimaryRunGroup = (run: FleetRunDTO): FleetGroupKey => {
  if (
    run.lifecycle === "input-required" ||
    run.lifecycle === "blocked" ||
    run.reasons.some((reason) => ATTENTION_REASONS.has(reason.code))
  ) {
    return "needs-attention";
  }

  if (ACTIVE_LIFECYCLES.has(run.lifecycle)) {
    return "active";
  }

  if (run.reasons.some((reason) => CLEANUP_REASONS.has(reason.code))) {
    return "cleanup-debt";
  }

  return "finished";
};

/** Filter canonical runs and return all four mutually exclusive groups. */
export const filterAndGroupRuns = (
  runs: readonly FleetRunDTO[],
  options: FleetFilterOptions = {}
): readonly FleetRunGroupDTO[] => {
  const repositories = asArray(options.repository);
  const lifecycles = asArray(options.lifecycle);
  const groups = asArray(options.group);

  const filtered = runs.filter((run) => {
    const group = getPrimaryRunGroup(run);
    return (
      matchesSearch(run, options.query ?? "") &&
      includesOneOf(run.repoId, repositories) &&
      includesOneOf(run.lifecycle, lifecycles) &&
      includesOneOf(group, groups)
    );
  });

  return GROUPS.map((group) => ({
    ...group,
    runs: filtered
      .filter((run) => getPrimaryRunGroup(run) === group.key)
      .sort(compareRuns),
  }));
};
