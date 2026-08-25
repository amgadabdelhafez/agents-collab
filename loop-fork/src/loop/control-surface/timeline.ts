import { createHash } from "node:crypto";
import { redactPublicText } from "./redaction";
import type { RunKey, SourceKind, TimelineInput, TimelineItem } from "./types";

const SOURCE_ORDER = new Map<SourceKind, number>(
  [
    "manifest",
    "hooks",
    "governess-state",
    "governess-control",
    "bridge",
    "utility",
    "usage",
    "adapter",
    "transcript",
  ].map((kind, index) => [kind as SourceKind, index])
);

export const createEvidenceRef = (
  key: RunKey,
  source: SourceKind,
  locator: string
): string =>
  `ev_${createHash("sha256").update(`${key.repoId}\0${key.runId}\0${source}\0${locator}`).digest("hex").slice(0, 24)}`;

export const buildTimeline = (
  key: RunKey,
  input: TimelineInput[],
  options: { cursor?: number; limit?: number } = {}
): { items: TimelineItem[]; nextCursor?: number } => {
  const cursor = Math.max(0, Math.trunc(options.cursor ?? 0));
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 100)));
  const ordered = input
    .map((event, index) => ({ event, index, timestamp: Date.parse(event.at) }))
    .filter((row) => Number.isFinite(row.timestamp))
    .sort(
      (left, right) =>
        left.timestamp - right.timestamp ||
        (SOURCE_ORDER.get(left.event.source) ?? 99) -
          (SOURCE_ORDER.get(right.event.source) ?? 99) ||
        left.index - right.index
    );
  const page = ordered
    .slice(cursor, cursor + limit)
    .map(({ event, index }) => ({
      at: new Date(Date.parse(event.at)).toISOString(),
      evidenceRef: createEvidenceRef(
        key,
        event.source,
        event.locator ?? String(index)
      ),
      message: redactPublicText(event.message),
      source: event.source,
    }));
  const next = cursor + page.length;
  return {
    items: page,
    ...(next < ordered.length ? { nextCursor: next } : {}),
  };
};
