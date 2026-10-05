/** Endpoint provenance only: a proxy's address does not establish backend host. */
export const judgeRouteLabel = (model: string, endpoint: string): string => {
  let location = "unavailable";
  try {
    const url = new URL(endpoint);
    if (url.protocol === "http:" || url.protocol === "https:") {
      location = url.origin;
    }
  } catch {
    // Never display unparsed configuration which may contain credentials.
  }
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
