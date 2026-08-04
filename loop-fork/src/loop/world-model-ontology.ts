export const WORLD_MODEL_ONTOLOGY_VERSION = "loop-world-v1";

export const WORLD_MODEL_ENTITY_TYPES = [
  "Repository",
  "Worktree",
  "Branch",
  "Commit",
  "Component",
  "File",
  "Symbol",
  "Dependency",
  "Spec",
  "Requirement",
  "Constraint",
  "Test",
  "Task",
  "Job",
  "RouteDecision",
  "Lease",
  "Run",
  "Session",
  "AgentRole",
  "Process",
  "Pane",
  "Port",
  "Decision",
  "Claim",
  "Evidence",
  "Finding",
  "Artifact",
  "Evaluation",
  "Metric",
  "ReleaseCandidate",
  "Deployment",
] as const;

export const WORLD_MODEL_PREDICATES = [
  "contains",
  "defines",
  "imports",
  "calls",
  "depends_on",
  "implements",
  "verifies",
  "violates",
  "supersedes",
  "produced_by",
  "observed_in",
  "derived_from",
  "bound_to_sha",
  "applies_to_scope",
  "authorized_by",
  "assigned_to",
  "routed_to",
  "blocked_by",
  "supports",
  "contradicts",
  "reviewed_by",
  "running_as",
  "deployed_as",
] as const;

export const WORLD_MODEL_STATUSES = [
  "observed",
  "asserted",
  "inferred",
  "disputed",
  "superseded",
] as const;

export type WorldEntityType = (typeof WORLD_MODEL_ENTITY_TYPES)[number];
export type WorldPredicate = (typeof WORLD_MODEL_PREDICATES)[number];
export type WorldStatementStatus = (typeof WORLD_MODEL_STATUSES)[number];

const ENTITY_TYPE_SET = new Set<string>(WORLD_MODEL_ENTITY_TYPES);
const PREDICATE_SET = new Set<string>(WORLD_MODEL_PREDICATES);
const STATUS_SET = new Set<string>(WORLD_MODEL_STATUSES);

export const isWorldEntityType = (value: string): value is WorldEntityType =>
  ENTITY_TYPE_SET.has(value);

export const isWorldPredicate = (value: string): value is WorldPredicate =>
  PREDICATE_SET.has(value);

export const isWorldStatementStatus = (
  value: string
): value is WorldStatementStatus => STATUS_SET.has(value);
