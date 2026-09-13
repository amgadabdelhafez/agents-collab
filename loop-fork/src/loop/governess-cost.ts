import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_USAGE_TRACKER_URL } from "./constants";
import { readAgentUsage } from "./governess-usage";
import {
  applyUsageTrackerPricing,
  readUsageTrackerLimits,
  type UsageTrackerPricing,
} from "./governess-usage-limits";
import { parseRoutingUsage, priceRoutingUsage } from "./routing-cost";
import { loadRunState, type RunManifest, type RunStorage } from "./run-state";

const ROUTED_METHOD =
  "derived-current-public-standard-rates; prompt * promptRate + completion * completionRate; not provider-billed USD";
const TOTAL_SOURCE =
  "sum of labelled routed derivation and subscription estimates; not an invoice";

const routedCost = async (storage: RunStorage, home: string) => {
  const source =
    process.env.LOOP_SWITCHYARD_ROUTING_LOG ??
    join(home, ".config", "loop", "switchyard", "routing.jsonl");
  const result = {
    costUsd: null as number | null,
    knownSubtotalUsd: null as number | null,
    method: ROUTED_METHOD,
    source,
    matchedRows: null as number | null,
    otherTaskRows: null as number | null,
    unattributedRows: null as number | null,
    countsSource: `${source}; whole-log counts, unowned rows never charged`,
    models: [] as Awaited<ReturnType<typeof priceRoutingUsage>>["models"],
    priceCache: null as
      | Awaited<ReturnType<typeof priceRoutingUsage>>["priceCache"]
      | null,
    reason: null as string | null,
  };
  try {
    const usage = parseRoutingUsage(
      readFileSync(source, "utf8"),
      storage.runId
    );
    result.matchedRows = usage.matchedRows;
    result.otherTaskRows = usage.otherTaskRows;
    result.unattributedRows = usage.unattributedRows;
    if (!usage.matchedRows) {
      result.reason =
        "No attributable routing rows; missing task headers cannot establish zero spend or ownership.";
      return result;
    }
    const collisions = readdirSync(storage.storageRoot).filter(
      (repo) =>
        repo !== storage.repoId &&
        existsSync(join(storage.storageRoot, repo, storage.runId))
    );
    if (collisions.length) {
      throw new Error(
        `ambiguous task ${storage.runId}: run ID also exists in ${collisions.join(", ")}; routing header has no repository namespace`
      );
    }
    const priced = await priceRoutingUsage(usage);
    result.models = priced.models;
    result.priceCache = priced.priceCache;
    result.knownSubtotalUsd = priced.costUsd;
    if (usage.unattributedRows > 0) {
      result.reason =
        "Unattributed rows excluded; only the matched subtotal is known. No timestamp ownership inference.";
    } else {
      result.costUsd = priced.costUsd;
    }
  } catch (error) {
    result.reason = `${source}: ${String(error)}`;
  }
  return result;
};

const subscriptionCost = (
  agent: "claude" | "codex",
  manifest: RunManifest,
  runDir: string,
  pricing?: UsageTrackerPricing
) => {
  const sessionRef =
    agent === "claude" ? manifest.claudeSessionId : manifest.codexThreadId;
  const usage = readAgentUsage(agent, sessionRef, join(runDir, "codex-home"));
  if (pricing) {
    applyUsageTrackerPricing(usage, agent, pricing);
  }
  const readable =
    usage.dataConfidence === "exact" || usage.dataConfidence === "approx";
  const covered = pricing
    ? usage.costEstimateCoveragePct === 100
    : Boolean(usage.model && (usage.costUsd > 0 || usage.totalTokens === 0));
  return {
    agent,
    costUsd: readable && covered ? usage.costUsd : null,
    method:
      usage.costEstimateBasis ??
      (pricing ? "unpriced" : "bundled-api-usd-estimate"),
    source: pricing?.source ?? "governess-usage.ts bundled rate table",
    tokenSource:
      agent === "claude"
        ? "Claude Code session transcript via readAgentUsage"
        : "Codex rollout via readAgentUsage (run-scoped home, existing transcript fallback)",
    sessionRef,
    model: usage.model ?? null,
    totalTokens: readable ? usage.totalTokens : null,
    reason:
      readable && covered
        ? null
        : "Subscription transcript or pricing coverage unavailable; not zero spend.",
  };
};

const subscriptionPricing = async () => {
  const disabled = ["0", "false", "off"].includes(
    process.env.LOOP_USAGE_TRACKER_LIMITS?.trim().toLowerCase() ?? ""
  );
  if (disabled) {
    return undefined;
  }
  const snapshot = await readUsageTrackerLimits({
    secret:
      process.env.LOOP_USAGE_TRACKER_SECRET || process.env.USAGE_TRACKER_SECRET,
    timeoutMs: Number(process.env.LOOP_USAGE_TRACKER_TIMEOUT_MS) || undefined,
    url:
      process.env.LOOP_USAGE_TRACKER_URL ||
      process.env.USAGE_TRACKER_URL ||
      DEFAULT_USAGE_TRACKER_URL,
  });
  return snapshot?.pricing;
};

export const governessCost = async (
  runId: string,
  cwd = process.cwd(),
  home = homedir()
) => {
  const { manifest, storage } = loadRunState(runId, cwd, home);
  if (
    !manifest ||
    manifest.runId !== runId ||
    manifest.repoId !== storage.repoId
  ) {
    throw new Error(
      `Missing or mismatched run manifest: ${storage.manifestPath}`
    );
  }
  const routed = await routedCost(storage, home);
  const pricing = await subscriptionPricing();
  const subscriptions = (["claude", "codex"] as const)
    .filter((agent) => {
      const ref =
        agent === "claude" ? manifest.claudeSessionId : manifest.codexThreadId;
      return (
        Boolean(ref) ||
        manifest.primaryAgent === agent ||
        manifest.tmuxPaneLeftAgent === agent ||
        manifest.tmuxPaneRightAgent === agent ||
        manifest.mode === `${agent}-only` ||
        (manifest.mode === "paired" &&
          !manifest.tmuxPaneLeftAgent &&
          !manifest.tmuxPaneRightAgent)
      );
    })
    .map((agent) => subscriptionCost(agent, manifest, storage.runDir, pricing));
  const knownComponents = [
    routed.knownSubtotalUsd,
    ...subscriptions.map((seat) => seat.costUsd),
  ].filter((value): value is number => value !== null);
  const knownSubtotalUsd = knownComponents.length
    ? knownComponents.reduce((sum, value) => sum + value, 0)
    : null;
  const complete =
    routed.costUsd !== null &&
    subscriptions.every((seat) => seat.costUsd !== null) &&
    Number.isFinite(knownSubtotalUsd);
  const task = {
    task: runId,
    identitySource:
      "x-switchyard-intake-task = Loop run ID; utility-job breakdown unavailable",
    costUsd: complete ? knownSubtotalUsd : null,
    knownSubtotalUsd,
    source: TOTAL_SOURCE,
    routed,
    subscriptions,
  };
  return {
    runId,
    runDir: storage.runDir,
    status: complete ? "complete" : "incomplete",
    costUsd: task.costUsd,
    knownSubtotalUsd,
    source: TOTAL_SOURCE,
    tasks: [task],
  };
};

export const formatGovernessCost = (
  report: Awaited<ReturnType<typeof governessCost>>
): string => {
  const usd = (value: number | null): string =>
    value === null ? "unknown" : `$${value.toFixed(8)}`;
  const lines = [
    `Run ${report.runId}: ${usd(report.costUsd)} (${report.status}); known subtotal ${usd(report.knownSubtotalUsd)} [source: ${report.source}]`,
    `Run directory: ${report.runDir}`,
  ];
  for (const task of report.tasks) {
    lines.push(
      `Task ${task.task}: ${usd(task.costUsd)}; known subtotal ${usd(task.knownSubtotalUsd)} [source: ${task.source}; identity: ${task.identitySource}]`
    );
    const { routed } = task;
    lines.push(
      `Routed: ${usd(routed.costUsd)}; matched subtotal ${usd(routed.knownSubtotalUsd)} [source: ${routed.source}; method: ${routed.method}]`
    );
    lines.push(
      `Routing rows: matched=${routed.matchedRows ?? "unknown"}, unattributed excluded=${routed.unattributedRows ?? "unknown"}, other task excluded=${routed.otherTaskRows ?? "unknown"} [source: ${routed.countsSource}]`
    );
    if (routed.reason) {
      lines.push(`Routed unavailable: ${routed.reason}`);
    }
    for (const model of routed.models) {
      lines.push(
        `  ${model.model}: ${usd(model.costUsd)} [source: ${routed.source}; prompt=${model.promptTokens}, completion=${model.completionTokens}, rows=${model.rows}; USD/token prompt=${model.promptRate}, completion=${model.completionRate}; rates: ${routed.priceCache?.url}; cache: ${routed.priceCache?.path}, fetched ${routed.priceCache?.fetchedAt}]`
      );
    }
    for (const seat of task.subscriptions) {
      lines.push(
        `${seat.agent}: ${usd(seat.costUsd)} [source: ${seat.source}; method: ${seat.method}; tokens=${seat.totalTokens ?? "unknown"}, token source: ${seat.tokenSource}; session=${seat.sessionRef}; model=${seat.model ?? "unknown"}]${seat.reason ? ` ${seat.reason}` : ""}`
      );
    }
  }
  return `${lines.join("\n")}\n`;
};

export const runGovernessCostCommand = async (
  argv: string[],
  cwd?: string,
  home?: string
): Promise<boolean> => {
  if (argv[0] !== "governess" || argv[1] !== "cost") {
    return false;
  }
  const runId = argv[2];
  if (
    !runId ||
    argv.length > 4 ||
    (argv[3] !== undefined && argv[3] !== "--json")
  ) {
    throw new Error("Usage: loop governess cost <run-id> [--json]");
  }
  const report = await governessCost(runId, cwd, home);
  process.stdout.write(
    argv[3] === "--json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatGovernessCost(report)
  );
  if (report.status !== "complete") {
    process.exitCode = 1;
  }
  return true;
};
