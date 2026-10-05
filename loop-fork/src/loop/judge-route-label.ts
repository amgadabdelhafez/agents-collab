const PINNED_QWEN_RE = /(?:^|\/)qwen(\d)(\d)-(\d+b)(?:\/|$)/i;
export const helperModelLabel = (model?: string): string => {
  if (!model) {
    return "—";
  }
  const pinnedQwen = model.match(PINNED_QWEN_RE);
  if (pinnedQwen) {
    return `Qwen${pinnedQwen[1]}.${pinnedQwen[2]}-${pinnedQwen[3].toUpperCase()}`;
  }
  return model.split("/").filter(Boolean).at(-1) ?? "—";
};

const httpEndpoint = (endpoint: string): URL | undefined => {
  try {
    const url = new URL(endpoint);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url
      : undefined;
  } catch {
    // Never display unparsed configuration which may contain credentials.
    return undefined;
  }
};

/** Compact credential-free endpoint (host:port only), for the default board. */
export const judgeEndpointHost = (endpoint: string): string =>
  httpEndpoint(endpoint)?.host || "unavailable";

/** Endpoint provenance only: a proxy's address does not establish backend host. */
export const judgeRouteLabel = (model: string, endpoint: string): string => {
  const location = httpEndpoint(endpoint)?.origin ?? "unavailable";
  const safeModel = [...model]
    .filter(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
    .join("")
    .slice(0, 100);
  const modelLabel = safeModel.startsWith("/")
    ? safeModel.split("/").filter(Boolean).slice(-2).join("/")
    : safeModel;
  return ` judge cfg ${modelLabel || "unknown"} · endpoint ${location}`;
};

/** Explicit operator-attested runtime metadata, never inferred from a proxy URL. */
export const judgeRuntimeLabel = (
  model: string,
  metadata: { model?: string; compute?: string; host?: string }
): string => {
  const clean = (value: string | undefined, fallback: string) =>
    [...(value ?? fallback)]
      .filter(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
      )
      .join("")
      .slice(0, 100);
  const fallback = model.startsWith("/")
    ? model.split("/").filter(Boolean).slice(-2).join("/")
    : model;
  return ` ${clean(metadata.model, fallback || "model unknown")} · ${clean(metadata.compute, "compute unknown")} · ${clean(metadata.host, "host unknown")}`;
};
