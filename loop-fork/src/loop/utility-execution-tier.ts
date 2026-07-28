import type { UtilityReadPlanStep, UtilityRouteRequest } from "./task-router";
import type { UtilityToolCall } from "./utility-tools";

export const UTILITY_DIRECT_TIER = "utility-direct" as const;
export const UTILITY_NANNY_TIER = "utility-nanny" as const;
export const UTILITY_AU_PAIR_TIER = "utility-au-pair" as const;

export type UtilityExecutionTierId =
  | typeof UTILITY_DIRECT_TIER
  | typeof UTILITY_NANNY_TIER
  | typeof UTILITY_AU_PAIR_TIER;

const NANNY_MAX_UNPROFILED_ACCEPTANCE_CRITERIA = 4;
const NANNY_MAX_UNPROFILED_READ_SCOPES = 2;
const NANNY_MAX_UNPROFILED_REQUEST_CHARS = 6000;

const directReadPlanCall = (
  step: UtilityReadPlanStep
): UtilityToolCall | undefined => {
  if (
    step.executionProfile === "focused-check" &&
    step.executionArgv &&
    step.executionCwd
  ) {
    return {
      arguments: {
        argv: [...step.executionArgv],
        cwd: step.executionCwd,
      },
      name: "run_check",
    };
  }
  if (step.executionProfile === "file-read" && step.executionRead) {
    return { arguments: step.executionRead, name: "read_file" };
  }
  if (step.executionProfile === "file-list" && step.readScope.length === 1) {
    return { arguments: { path: step.readScope[0] }, name: "list_files" };
  }
  if (
    step.executionProfile === "git-status" &&
    step.readScope.length === 1 &&
    step.readScope[0] === "."
  ) {
    return { arguments: {}, name: "git_status" };
  }
  if (step.executionProfile === "git-diff") {
    return {
      arguments: {
        paths:
          step.readScope.length === 1 && step.readScope[0] === "."
            ? []
            : [...step.readScope],
      },
      name: "git_diff",
    };
  }
  return undefined;
};

export const directUtilityCalls = (
  request: UtilityRouteRequest
): UtilityToolCall[] | undefined => {
  if (request.executionProfile === "file-read" && request.executionRead) {
    return [{ arguments: request.executionRead, name: "read_file" }];
  }
  if (
    request.executionProfile === "focused-check" &&
    request.executionArgv &&
    request.executionCwd
  ) {
    return [
      {
        arguments: {
          argv: [...request.executionArgv],
          cwd: request.executionCwd,
        },
        name: "run_check",
      },
    ];
  }
  if (request.executionProfile !== "read-plan") {
    return undefined;
  }
  const plan = request.executionPlan ?? [];
  if (plan.length === 0) {
    return undefined;
  }
  const calls = plan.map(directReadPlanCall);
  return calls.every((call): call is UtilityToolCall => call !== undefined)
    ? calls
    : undefined;
};

const hasAuthority = (request: UtilityRouteRequest): boolean =>
  Object.values(request.authority).some((value) => value === true);

const nannyCommonBoundary = (request: UtilityRouteRequest): boolean =>
  request.risk === "low" &&
  request.writeScope.length === 0 &&
  !request.requiredCapabilities.includes("scoped-edit") &&
  !hasAuthority(request) &&
  (request.contextRefs?.length ?? 0) <= 2;

const unprofiledBoundedInspection = (request: UtilityRouteRequest): boolean => {
  const requestChars =
    request.objective.length +
    request.acceptanceCriteria.reduce(
      (total, criterion) => total + criterion.length,
      0
    );
  return (
    nannyCommonBoundary(request) &&
    request.kind === "inspect" &&
    request.requiredCapabilities.length === 1 &&
    request.requiredCapabilities[0] === "inspect" &&
    request.readScope.length >= 1 &&
    request.readScope.length <= NANNY_MAX_UNPROFILED_READ_SCOPES &&
    request.acceptanceCriteria.length >= 1 &&
    request.acceptanceCriteria.length <=
      NANNY_MAX_UNPROFILED_ACCEPTANCE_CRITERIA &&
    requestChars <= NANNY_MAX_UNPROFILED_REQUEST_CHARS &&
    request.executionProfile === undefined &&
    request.executionArgv === undefined &&
    request.executionCwd === undefined &&
    request.executionOutput === undefined &&
    request.executionPlan === undefined &&
    request.executionRead === undefined
  );
};

export const classifyUtilityExecution = (
  request: UtilityRouteRequest
): UtilityExecutionTierId => {
  if (directUtilityCalls(request)) {
    return UTILITY_DIRECT_TIER;
  }
  const smallReadPlan =
    request.executionProfile !== "read-plan" ||
    (request.executionPlan?.length ?? Number.POSITIVE_INFINITY) <= 4;
  const profiledNannyEligible =
    nannyCommonBoundary(request) &&
    request.kind !== "edit" &&
    (request.kind === "inspect" || request.kind === "command") &&
    request.executionProfile !== undefined &&
    request.readScope.length <= 4 &&
    smallReadPlan;
  return profiledNannyEligible || unprofiledBoundedInspection(request)
    ? UTILITY_NANNY_TIER
    : UTILITY_AU_PAIR_TIER;
};

export const utilityRoleName = (
  tierId: string | undefined
): "Direct" | "Nanny" | "Au Pair" => {
  if (tierId === UTILITY_DIRECT_TIER) {
    return "Direct";
  }
  return tierId === UTILITY_NANNY_TIER ? "Nanny" : "Au Pair";
};
