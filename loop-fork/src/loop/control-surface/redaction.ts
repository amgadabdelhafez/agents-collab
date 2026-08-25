import type { PublicAdapterIdentity, PublicResolvedConfig } from "./types";

const URL_RE = /\b(?:https?|wss?):\/\/\S+/giu;
const ABSOLUTE_PATH_RE = /(^|[^A-Za-z0-9<])(?:\/[\w.@+-]+)+/gu;
const AUTHORIZATION_RE = /\bauthorization\s*[:=]\s*[^\r\n]+/giu;
const SECRET_RE =
  /\b(?:token|password|secret|credential|authorization|api[_-]?key)\s*[:=]\s*\S+/giu;
const PROCESS_BIRTH_RE = /^(?:darwin|linux):[1-9][0-9]*$/u;
const removeControlCharacters = (value: string): string =>
  Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
      );
    })
    .join("");

export const redactPublicText = (value: unknown, maxLength = 500): string =>
  removeControlCharacters(String(value ?? ""))
    .replace(AUTHORIZATION_RE, "[redacted]")
    .replace(SECRET_RE, "[redacted]")
    .replace(URL_RE, "[url]")
    .replace(ABSOLUTE_PATH_RE, "$1[path]")
    .slice(0, maxLength);

export const escapePublicText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const booleanValue = (value: unknown): boolean => value === true;

export const selectPublicConfig = (
  value: unknown
): PublicResolvedConfig | undefined => {
  if (
    !value ||
    typeof value !== "object" ||
    (value as { version?: unknown }).version !== 1
  ) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const booleanKeys = [
    "governess",
    "pairedMode",
    "proofConfigured",
    "tmux",
    "worktree",
  ];
  const reviews = new Set([
    "claude",
    "claudex",
    "codex",
    "copilot",
    "cursor",
    "gemini",
  ]);
  const planReviews = new Set([
    "claude",
    "codex",
    "copilot",
    "cursor",
    "gemini",
    "none",
    "other",
  ]);
  if (booleanKeys.some((key) => typeof source[key] !== "boolean")) {
    return undefined;
  }
  if (source.review !== undefined && !reviews.has(String(source.review))) {
    return undefined;
  }
  if (
    source.reviewPlan !== undefined &&
    !planReviews.has(String(source.reviewPlan))
  ) {
    return undefined;
  }
  return {
    governess: booleanValue(source.governess),
    pairedMode: booleanValue(source.pairedMode),
    proofConfigured: booleanValue(source.proofConfigured),
    ...(source.review === undefined
      ? {}
      : { review: source.review as PublicResolvedConfig["review"] }),
    ...(source.reviewPlan === undefined
      ? {}
      : {
          reviewPlan: source.reviewPlan as PublicResolvedConfig["reviewPlan"],
        }),
    tmux: booleanValue(source.tmux),
    version: 1,
    worktree: booleanValue(source.worktree),
  };
};

export const selectPublicAdapter = (
  value: unknown
): PublicAdapterIdentity | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  if (
    source.version !== 1 ||
    typeof source.processBirthId !== "string" ||
    typeof source.serverPid !== "number" ||
    !Number.isSafeInteger(source.serverPid) ||
    source.serverPid <= 0 ||
    !PROCESS_BIRTH_RE.test(source.processBirthId)
  ) {
    return undefined;
  }
  return {
    processBirthId: redactPublicText(source.processBirthId, 64),
    serverPid: source.serverPid,
    version: 1,
  };
};
