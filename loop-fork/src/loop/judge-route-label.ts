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
  return ` judge cfg ${safeModel || "unknown"} · endpoint ${location}`;
};
