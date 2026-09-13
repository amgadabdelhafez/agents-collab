import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const PRICE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface RoutingModelUsage {
  completionTokens: number;
  model: string;
  promptTokens: number;
  rows: number;
}

export interface RoutingUsage {
  matchedRows: number;
  models: RoutingModelUsage[];
  otherTaskRows: number;
  unattributedRows: number;
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return value as Record<string, unknown>;
};

const tokenCount = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${label}`);
  }
  return value;
};

export const parseRoutingUsage = (text: string, task: string): RoutingUsage => {
  const models = new Map<string, RoutingModelUsage>();
  const summary: RoutingUsage = {
    matchedRows: 0,
    models: [],
    otherTaskRows: 0,
    unattributedRows: 0,
  };
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) {
      continue;
    }
    try {
      const row = record(JSON.parse(line));
      if (
        row.task == null ||
        (typeof row.task === "string" && !row.task.trim())
      ) {
        summary.unattributedRows += 1;
        continue;
      }
      if (typeof row.task !== "string") {
        throw new Error("invalid task identity");
      }
      if (row.task !== task) {
        summary.otherTaskRows += 1;
        continue;
      }
      const model = row.model;
      if (typeof model !== "string" || !model.trim()) {
        throw new Error("missing routing model");
      }
      const usage = models.get(model) ?? {
        completionTokens: 0,
        model,
        promptTokens: 0,
        rows: 0,
      };
      usage.promptTokens = tokenCount(
        usage.promptTokens +
          tokenCount(row.prompt_tokens, `prompt_tokens for model ${model}`),
        `prompt token sum for model ${model}`
      );
      usage.completionTokens = tokenCount(
        usage.completionTokens +
          tokenCount(
            row.completion_tokens,
            `completion_tokens for model ${model}`
          ),
        `completion token sum for model ${model}`
      );
      usage.rows += 1;
      models.set(model, usage);
      summary.matchedRows += 1;
    } catch (error) {
      throw new Error(`routing line ${index + 1}: ${String(error)}`);
    }
  }
  summary.models = [...models.values()];
  return summary;
};

const priceRate = (value: unknown, model: string, key: string): number => {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !value.trim()) ||
    !Number.isFinite(Number(value)) ||
    Number(value) < 0
  ) {
    throw new Error(`missing or invalid pricing.${key} for model ${model}`);
  }
  return Number(value);
};

export const deriveRoutingCost = (usage: RoutingUsage, payload: unknown) => {
  const data = record(payload).data;
  if (!Array.isArray(data)) {
    throw new Error("expected OpenRouter models response with a data array");
  }
  return usage.models.map((modelUsage) => {
    const { model, promptTokens, completionTokens } = modelUsage;
    const matches = data.filter((entry) => record(entry).id === model);
    if (matches.length !== 1) {
      throw new Error(
        `${matches.length ? "duplicate" : "missing"} price for model ${model}`
      );
    }
    const rawPricing = record(matches[0]).pricing;
    if (
      !rawPricing ||
      typeof rawPricing !== "object" ||
      Array.isArray(rawPricing)
    ) {
      throw new Error(`missing pricing for model ${model}`);
    }
    const pricing = record(rawPricing);
    const promptRate = priceRate(pricing.prompt, model, "prompt");
    const completionRate = priceRate(pricing.completion, model, "completion");
    // Cache and reasoning counters are subsets, not extra billable tokens.
    const costUsd =
      promptTokens * promptRate + completionTokens * completionRate;
    if (!Number.isFinite(costUsd)) {
      throw new Error(`non-finite routing cost for model ${model}`);
    }
    return { ...modelUsage, completionRate, costUsd, promptRate };
  });
};

export interface RoutingCostOptions {
  // An explicit cache is offline-only: no surprise refresh of supplied evidence.
  priceCachePath?: string;
}

export const priceRoutingUsage = async (
  usage: RoutingUsage,
  options: RoutingCostOptions = {}
) => {
  const override =
    options.priceCachePath ?? process.env.LOOP_OPENROUTER_PRICE_CACHE;
  const path = resolve(
    override ?? join(homedir(), ".cache", "loop", "openrouter-models.json")
  );
  const names = usage.models.map(({ model }) => model).join(", ");
  try {
    const age = existsSync(path)
      ? Date.now() - Math.floor(statSync(path).mtimeMs)
      : Number.POSITIVE_INFINITY;
    let payload: unknown;
    if (age >= 0 && age <= PRICE_CACHE_MAX_AGE_MS) {
      payload = JSON.parse(readFileSync(path, "utf8"));
    } else {
      if (override) {
        throw new Error(
          "missing or stale offline price cache (maximum age: 24 hours)"
        );
      }
      const startedAt = Date.now();
      let ok = false;
      try {
        const response = await fetch(OPENROUTER_MODELS_URL, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          throw new Error(`OpenRouter models HTTP ${response.status}`);
        }
        payload = await response.json();
        deriveRoutingCost(usage, payload);
        ok = true;
      } finally {
        console.error(
          JSON.stringify({
            durationMs: Date.now() - startedAt,
            kind: "governess-cost-price-fetch",
            ok,
            startedAt,
            url: OPENROUTER_MODELS_URL,
          })
        );
      }
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify(payload)}\n`, {
          flag: "wx",
        });
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    const models = deriveRoutingCost(usage, payload);
    const costUsd = models.reduce((sum, item) => sum + item.costUsd, 0);
    if (!Number.isFinite(costUsd)) {
      throw new Error("non-finite routing cost sum");
    }
    return {
      costUsd,
      models,
      priceCache: {
        fetchedAt: new Date(statSync(path).mtimeMs).toISOString(),
        path,
        url: OPENROUTER_MODELS_URL,
      },
    };
  } catch (error) {
    throw new Error(
      `OpenRouter price for model(s) ${names}: ${String(error)}; cache: ${path}`
    );
  }
};
