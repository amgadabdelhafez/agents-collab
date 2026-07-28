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

const bounded = (value: string, width: number): string =>
  sanitizeUtilityPaneText(value).replace(/\s+/g, " ").trim().slice(0, width);

const wrapped = (value: string, width: number): string[] => {
  let safe = sanitizeUtilityPaneText(value).replace(/\s+/g, " ").trim();
  const lines: string[] = [];
  while (safe.length > width) {
    const breakAt = safe.lastIndexOf(" ", width);
    const end = breakAt >= Math.floor(width / 2) ? breakAt : width;
    lines.push(safe.slice(0, end));
    safe = safe.slice(end).trimStart();
  }
  if (safe) {
    lines.push(safe);
  }
  return lines.length > 0 ? lines : [""];
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
      `ROUTES  routed ${routing.routed}/${routing.considered}  active ${snapshot.active}  queued ${snapshot.queued}  auto ${routing.autoRouted} explicit ${routing.explicitRouted}`,
      width
    ),
    ...jobs.map((job) => {
      const route = job.decision
        ? `${job.decision.tierId ?? job.decision.target}/${job.decision.reason}`
        : "pending-route";
      return bounded(
        `${age(job.updatedAt)} ${job.jobId.slice(0, 8)} ${job.state} ${route} · ${job.request.objective}`,
        width
      );
    }),
  ];
};

const renderTools = (runDir: string, width: number): string[] => {
  const events = readToolEvents(runDir).slice(-16).reverse();
  const failed = events.filter((event) => event.ok === false).length;
  return [
    bounded(`TOOLS  recent ${events.length}  failed ${failed}`, width),
    ...events.flatMap((event) => {
      const error =
        event.error && typeof event.error === "object"
          ? (event.error as Record<string, unknown>)
          : undefined;
      const detail =
        event.ok === true
          ? "ok"
          : `${String(error?.code ?? "unknown")}: ${String(error?.message ?? "broker rejection")}`;
      return wrapped(
        `${age(String(event.at ?? ""))} ${String(event.jobId ?? "").slice(0, 8)} ${String(event.tool ?? "tool")} · ${detail}`,
        width
      );
    }),
  ];
};

const renderResults = (runDir: string, width: number): string[] => {
  const pending = readPendingBridgeMessages(runDir).filter(
    (message) => message.source === "utility"
  );
  const results = readUtilityJobsForObservability(runDir)
    .filter((job) => job.result)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 12);
  return [
    bounded(
      `RESULTS  finished ${results.length}  bridge pending ${pending.length}`,
      width
    ),
    ...pending
      .slice(0, 4)
      .map((message) =>
        bounded(
          `pending→${message.target} ${message.taskId?.slice(0, 8) ?? "no-task"} · ${message.message}`,
          width
        )
      ),
    ...results.map((job) =>
      bounded(
        `${age(job.updatedAt)} ${job.jobId.slice(0, 8)} ${job.result?.status ?? job.state} · ${job.result?.blocker ?? job.result?.summary ?? ""}`,
        width
      )
    ),
  ];
};

export const renderReconPane = (
  runDir: string,
  index: ReconPaneIndex,
  viewport: ReconViewport = {}
): string => {
  const width = Math.max(24, viewport.columns ?? 80);
  const rows = Math.max(2, viewport.rows ?? 12);
  let lines = renderResults(runDir, width);
  if (index === 1) {
    lines = renderRoutes(runDir, width);
  } else if (index === 2) {
    lines = renderTools(runDir, width);
  }
  return lines.slice(0, rows).join("\n");
};

export const runReconPane = async (
  runDir: string,
  index: ReconPaneIndex
): Promise<void> => {
  for (;;) {
    process.stdout.write(
      `\u001b[2J\u001b[H${renderReconPane(runDir, index, {
        columns: process.stdout.columns,
        rows: process.stdout.rows,
      })}\n`
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};
