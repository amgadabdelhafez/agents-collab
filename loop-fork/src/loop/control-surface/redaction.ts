import type { PublicAdapterIdentity, PublicResolvedConfig } from "./types";

const URL_RE = /\b(?:https?|wss?):\/\/\S+/giu;
const ABSOLUTE_PATH_RE = /(?:\/[\w.@+-]+){2,}/gu;
const SECRET_RE =
  /\b(?:token|password|secret|credential|authorization|api[_-]?key)\s*[:=]\s*\S+/giu;
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
    .replace(SECRET_RE, "[redacted]")
    .replace(URL_RE, "[url]")
    .replace(ABSOLUTE_PATH_RE, "[path]")
    .slice(0, maxLength);

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
  return {
    governess: booleanValue(source.governess),
    pairedMode: booleanValue(source.pairedMode),
    proofConfigured: booleanValue(source.proofConfigured),
    ...(source.review === "independent" || source.review === "none"
      ? { review: source.review }
      : {}),
    ...(source.reviewPlan === "independent" || source.reviewPlan === "none"
      ? { reviewPlan: source.reviewPlan }
      : {}),
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
    !Number.isSafeInteger(source.serverPid)
  ) {
    return undefined;
  }
  return {
    processBirthId: redactPublicText(source.processBirthId, 64),
    serverPid: source.serverPid,
    version: 1,
  };
};
