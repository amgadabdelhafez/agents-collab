// Context windows, resolved instead of remembered.
//
// A hand-maintained table of model windows rots the moment a model ships, and
// the rot is silent: an unknown model falls to a 200k default and every
// percentage, threshold and handover computed from it is wrong. Two live
// examples from this file's own former table, both found on 2026-09-06:
//   claude-opus-5   absent      -> read as 200,000, actual 1,000,000
//   gpt-5.5         1,050,000   -> actual 272,000 (that is gpt-5.5-pro's)
//
// pi-ai ships a built-in catalog with the window for every model the loop can
// drive, and the loop already depends on pi-ai. So the order of trust is:
//   1. what the seat's own transcript reported (a provider's own number)
//   2. pi-ai's catalog
//   3. this file's table, kept only as a fallback for models the catalog
//      does not carry (local and self-hosted ids)
//   4. the 200k default, which is a floor, not a fact
// `resolveContextWindow` records which of those answered, so a wrong number is
// attributable instead of anonymous.

import { getModels as getCatalogModels } from "@earendil-works/pi-ai/compat";

export const DEFAULT_CONTEXT_WINDOW = 200_000;

export type WindowSource = "transcript" | "catalog" | "table" | "default";

export interface ContextWindowResolution {
  catalog?: number;
  chosen: number;
  source: WindowSource;
  table?: number;
  transcript?: number;
}

// Fallback only. Anything the catalog knows is answered before this is read.
const CONTEXT_WINDOW: Record<string, number> = {
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "claude-fable-5": 1_000_000,
};

export const tableContextWindow = (model: string): number | undefined => {
  const key = Object.keys(CONTEXT_WINDOW).find(
    (candidate) => model === candidate || model.startsWith(candidate)
  );
  return key ? CONTEXT_WINDOW[key] : undefined;
};

type CatalogLookup = (model: string) => number | undefined;

const CATALOG_PROVIDERS = ["anthropic", "openai", "openrouter"] as const;

let catalogCache: Map<string, number> | undefined;

const loadCatalog = (): Map<string, number> => {
  if (catalogCache) {
    return catalogCache;
  }
  const map = new Map<string, number>();
  for (const provider of CATALOG_PROVIDERS) {
    let models: readonly { contextWindow?: number; id: string }[] = [];
    try {
      models = getCatalogModels(provider) ?? [];
    } catch {
      // A provider whose catalog throws yields nothing; the resolver says so.
    }
    for (const model of models) {
      if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
        map.set(model.id, model.contextWindow);
        // OpenRouter ids carry a vendor prefix; index the bare id too.
        const bare = model.id.includes("/")
          ? model.id.slice(model.id.indexOf("/") + 1)
          : model.id;
        if (!map.has(bare)) {
          map.set(bare, model.contextWindow);
        }
      }
    }
  }
  catalogCache = map;
  return map;
};

// A seat reports itself provider-qualified (openrouter/z-ai/glm-5.2) while the
// catalog is indexed by the id the provider serves (z-ai/glm-5.2) and its bare
// tail (glm-5.2). Looking up only the qualified form missed every routed seat
// and silently returned the 200k default: on 2026-09-06 an OSS seat with a
// 1,048,576 window was governed as if it had 200,000. So try the id as given,
// then peel one leading segment at a time.
const catalogCandidates = (model: string): string[] => {
  const seen: string[] = [];
  const push = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed && !seen.includes(trimmed)) {
      seen.push(trimmed);
    }
  };
  let rest = model.trim();
  push(rest);
  while (rest.includes("/")) {
    rest = rest.slice(rest.indexOf("/") + 1);
    push(rest);
  }
  return seen;
};

export const catalogContextWindow: CatalogLookup = (model) => {
  const catalog = loadCatalog();
  for (const candidate of catalogCandidates(model)) {
    if (catalog.has(candidate)) {
      return catalog.get(candidate);
    }
    // Date-suffixed or dotted variants: claude-opus-4-6-20260101, claude-opus-4.6
    const dashed = candidate.replace(/\./g, "-");
    if (catalog.has(dashed)) {
      return catalog.get(dashed);
    }
    const prefix = [...catalog.keys()].find(
      (id) => candidate.startsWith(`${id}-`) || dashed.startsWith(`${id}-`)
    );
    if (prefix) {
      return catalog.get(prefix);
    }
  }
  return undefined;
};

export const resolveContextWindow = (
  model: string | undefined,
  transcriptWindow: number | undefined,
  lookup: CatalogLookup = catalogContextWindow
): ContextWindowResolution => {
  const transcript =
    transcriptWindow &&
    transcriptWindow > 0 &&
    transcriptWindow !== DEFAULT_CONTEXT_WINDOW
      ? transcriptWindow
      : undefined;
  const catalog = model ? lookup(model) : undefined;
  const table = model ? tableContextWindow(model) : undefined;
  if (transcript) {
    return {
      catalog,
      chosen: transcript,
      source: "transcript",
      table,
      transcript,
    };
  }
  if (catalog) {
    return { catalog, chosen: catalog, source: "catalog", table };
  }
  if (table) {
    return { catalog, chosen: table, source: "table", table };
  }
  return { catalog, chosen: DEFAULT_CONTEXT_WINDOW, source: "default", table };
};

// The window a decision should use, without the provenance.
export const contextWindowFor = (
  model: string | undefined,
  transcriptWindow?: number
): number => resolveContextWindow(model, transcriptWindow).chosen;
