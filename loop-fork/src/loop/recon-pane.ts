import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readPendingBridgeMessages } from "./bridge-store";
import {
  readUtilityObservability,
  sanitizeUtilityPaneText,
} from "./utility-observability";
import { readUtilityJobsForObservability } from "./utility-store";

export const RECON_PANE_SUBCOMMAND = "__recon-pane";
export type ReconPaneIndex = 1 | 2 | 3;

interface ReconViewport {
  columns?: number;
  rows?: number;
}

const LINE_SPLIT_RE = /\r?\n/;
const SEPARATOR_LINE_RE = /^[-=]+$/;
const DIRECT_RESULT_PREFIX_RE = /^Direct result\s+\S+(?:\s+failed)?\s*:\s*/i;
const TOOL_PAYLOAD_RE = /^[a-z][a-z0-9_]*\s*:\s*(\{[\s\S]*\})$/i;
const MARKDOWN_HEADING_RE = /^#+\s*/;
const MARKDOWN_QUOTE_RE = /^>\s*/;
const DIRECT_PREFIX_RE = /^Direct\s+/;

const bounded = (value: string, width: number): string =>
  sanitizeUtilityPaneText(value).replace(/\s+/g, " ").trim().slice(0, width);

const firstUsefulLine = (value: string): string =>
  value
    .split(LINE_SPLIT_RE)
    .map((line) => sanitizeUtilityPaneText(line).trim())
    .find((line) => line.length > 0 && !SEPARATOR_LINE_RE.test(line)) ?? "—";

const compactResultText = (value: string): string => {
  let safe = sanitizeUtilityPaneText(value).trim();
  safe = safe.replace(DIRECT_RESULT_PREFIX_RE, "");
  const toolPayload = safe.match(TOOL_PAYLOAD_RE);
  if (toolPayload) {
    try {
      const parsed = JSON.parse(toolPayload[1]) as Record<string, unknown>;
      if (typeof parsed.content === "string") {
        safe = parsed.content;
      }
    } catch {
      // Keep the sanitized original when a tool payload is only partial JSON.
    }
  }
  return firstUsefulLine(safe)
    .replace(MARKDOWN_HEADING_RE, "")
    .replace(MARKDOWN_QUOTE_RE, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(DIRECT_PREFIX_RE, "")
    .replace(/\s+/g, " ")
    .trim();
};

const age = (at: string): string => {
  const elapsed = Date.now() - Date.parse(at);
  if (!Number.isFinite(elapsed)) {
    return "—";
  }
  if (elapsed < 60_000) {
    return `${Math.max(0, Math.floor(elapsed / 1000))}s`;
  }
  return `${Math.floor(elapsed / 60_000)}m`;
};

const readToolEvents = (runDir: string): Record<string, unknown>[] => {
  const path = join(runDir, "utility", "tool-events.jsonl");
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
};

const renderRoutes = (runDir: string, width: number): string[] => {
  const snapshot = readUtilityObservability(runDir);
  const routing = snapshot.routing;
  const jobs = readUtilityJobsForObservability(runDir)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 12);
  return [
    bounded(
      `ROUTES  ${routing.routed}/${routing.considered} routed · ${snapshot.active} active · ${snapshot.queued} queued · ${routing.autoRouted} auto · ${routing.explicitRouted} asked`,
      width
    ),
    ...jobs.map((job) => {
      const route = (() => {
        if (!job.decision) {
          return "queued";
        }
        if (job.decision.target === "driver") {
          return "driver";
        }
        if (job.decision.tierId === "utility-direct") {
          return "direct";
        }
        if (job.decision.tierId === "utility-nanny") {
          return "nanny";
        }
        if (job.decision.tierId === "utility-au-pair") {
          return "au pair";
        }
        return "utility";
      })();
      const state = (() => {
        if (job.state === "completed") {
          return "✓";
        }
        if (job.state === "failed") {
          return "✗";
        }
        if (job.state === "running" || job.state === "claimed") {
          return "…";
        }
        return "→";
      })();
      const reason =
        job.decision?.target === "driver" &&
        job.decision.reason &&
        job.decision.reason !== "request-not-bounded"
          ? ` (${job.decision.reason.replace(/-/g, " ")})`
          : "";
      return bounded(
        `${age(job.updatedAt)} ${state} ${route}${reason} · ${job.request.objective}`,
        width
      );
    }),
  ];
};

const renderTools = (runDir: string, width: number): string[] => {
  const events = readToolEvents(runDir).slice(-16).reverse();
  const failed = events.filter((event) => event.ok === false).length;
  const grouped = new Map<
    string,
    { count: number; detail: string; event: Record<string, unknown> }
  >();
  for (const event of events) {
    const error =
      event.error && typeof event.error === "object"
        ? (event.error as Record<string, unknown>)
        : undefined;
    const detail =
      event.ok === true
        ? ""
        : `${String(error?.code ?? "unknown")}: ${String(error?.message ?? "broker rejection")}`;
    const key = [
      String(event.jobId ?? ""),
      String(event.tool ?? "tool"),
      String(event.ok),
      detail,
    ].join("\u0000");
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      grouped.set(key, { count: 1, detail, event });
    }
  }
  return [
    bounded(`TOOLS  ${events.length} recent · ${failed} failed`, width),
    ...[...grouped.values()].map(({ count, detail, event }) =>
      bounded(
        `${age(String(event.at ?? ""))} ${event.ok === true ? "✓" : "✗"} ${String(event.tool ?? "tool")}${count > 1 ? ` ×${count}` : ""}${detail ? ` · ${detail}` : ""}`,
        width
      )
    ),
  ];
};

const renderResults = (runDir: string, width: number): string[] => {
  const pending = readPendingBridgeMessages(runDir).filter(
    (message) => message.source === "utility"
  );
  const pendingTaskIds = new Set(
    pending.flatMap((message) => (message.taskId ? [message.taskId] : []))
  );
  const allResults = readUtilityJobsForObservability(runDir)
    .filter((job) => job.result)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const results = allResults
    .filter((job) => !pendingTaskIds.has(job.jobId))
    .slice(0, 12);
  return [
    bounded(
      `RESULTS  ${Math.min(allResults.length, 12)} recent · ${pending.length} awaiting delivery`,
      width
    ),
    ...pending
      .slice(0, 4)
      .map((message) =>
        bounded(
          `→ ${message.target} awaiting · ${compactResultText(message.message)}`,
          width
        )
      ),
    ...results.map((job) =>
      bounded(
        `${age(job.updatedAt)} ${job.result?.status === "failed" || job.state === "failed" ? "✗" : "✓"} ${compactResultText(job.result?.blocker ?? job.result?.summary ?? "")}`,
        width
      )
    ),
  ];
};

const renderCombined = (
  runDir: string,
  width: number,
  rows: number
): string[] => {
  const sections = [
    renderRoutes(runDir, width),
    renderTools(runDir, width),
    renderResults(runDir, width),
  ];
  if (rows <= sections.length) {
    return sections.map((section) => section[0] ?? "—").slice(0, rows);
  }
  const remaining = rows - sections.length;
  const routeBudget = Math.ceil(remaining * 0.4);
  const toolBudget = Math.min(
    remaining - routeBudget,
    Math.ceil(remaining * 0.25)
  );
  const resultBudget = Math.max(0, remaining - routeBudget - toolBudget);
  const budgets = [routeBudget, toolBudget, resultBudget];
  return sections.flatMap((section, index) => [
    section[0] ?? "—",
    ...section.slice(1, 1 + (budgets[index] ?? 0)),
  ]);
};

export const renderReconPane = (
  runDir: string,
  index: ReconPaneIndex,
  viewport: ReconViewport = {}
): string => {
  const width = Math.max(24, viewport.columns ?? 80);
  const rows = Math.max(2, viewport.rows ?? 12);
  let lines = renderCombined(runDir, width, rows);
  if (index === 2) {
    lines = renderTools(runDir, width);
  } else if (index === 3) {
    lines = renderResults(runDir, width);
  }
  return lines.slice(0, rows).join("\n");
};

export const runReconPane = async (
  runDir: string,
  index: ReconPaneIndex
): Promise<void> => {
  let previous = "";
  if (process.stdout.isTTY) {
    process.stdout.write("\u001b[?1049h\u001b[?25l");
    process.once("exit", () => {
      process.stdout.write("\u001b[?25h\u001b[?1049l");
    });
  }
  for (;;) {
    const rendered = renderReconPane(runDir, index, {
      columns: process.stdout.columns,
      rows: process.stdout.rows,
    });
    if (rendered !== previous) {
      process.stdout.write(`\u001b[2J\u001b[H${rendered}`);
      previous = rendered;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};
