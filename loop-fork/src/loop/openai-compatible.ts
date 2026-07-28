const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const MAX_RETRIES = 5;
const MAX_ERROR_BODY_CHARS = 8000;
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_RE =
  /(?:authorization|api[-_]?key|token|secret|password|cookie)/i;

export interface OpenAICompatibleFunctionCall {
  arguments: string;
  name: string;
}

export interface OpenAICompatibleToolCall {
  function: OpenAICompatibleFunctionCall;
  id: string;
  type: "function";
}

export type OpenAICompatibleMessage =
  | {
      content: string;
      role: "system" | "user";
    }
  | {
      content: string | null;
      role: "assistant";
      tool_calls?: OpenAICompatibleToolCall[];
    }
  | {
      content: string;
      name?: string;
      role: "tool";
      tool_call_id: string;
    };

export interface OpenAICompatibleTool {
  function: {
    description?: string;
    name: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
  type: "function";
}

export type OpenAICompatibleToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      function: { name: string };
      type: "function";
    };

export interface OpenAICompatibleUsage {
  cachedInputTokens: number;
  cost?: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  upstreamInferenceCost?: number;
}

interface TraceBase {
  attempt: number;
  timestamp: string;
}

export type OpenAICompatibleTraceEvent =
  | (TraceBase & {
      request: Record<string, unknown>;
      type: "request";
      url: string;
    })
  | (TraceBase & {
      delayMs: number;
      status: number;
      type: "retry";
    })
  | (TraceBase & {
      durationMs: number;
      response: unknown;
      status: number;
      type: "response";
    })
  | (TraceBase & {
      error: string;
      type: "error";
    });

export interface OpenAICompatibleChatRequest {
  apiKey?: string;
  endpoint: string;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  maxTokens?: number;
  messages: OpenAICompatibleMessage[];
  model: string;
  onTrace?: (event: OpenAICompatibleTraceEvent) => void;
  provider?: {
    sort?: "price" | "throughput" | "latency" | "exacto";
  };
  retryBaseDelayMs?: number;
  temperature?: number;
  timeoutMs?: number;
  toolChoice?: OpenAICompatibleToolChoice;
  tools?: OpenAICompatibleTool[];
}

export type OpenAICompatibleErrorKind =
  | "http"
  | "invalid-response"
  | "network"
  | "timeout";

export interface OpenAICompatibleError {
  body?: unknown;
  kind: OpenAICompatibleErrorKind;
  message: string;
  retryable: boolean;
  status?: number;
}

interface ResultBase {
  attempts: number;
  durationMs: number;
  usage: OpenAICompatibleUsage;
}

export type OpenAICompatibleChatResult =
  | (ResultBase & {
      finishReason: string | null;
      id?: string;
      message: Extract<OpenAICompatibleMessage, { role: "assistant" }>;
      model: string;
      ok: true;
    })
  | (ResultBase & {
      error: OpenAICompatibleError;
      ok: false;
    });

export interface OpenAICompatibleDependencies {
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

const emptyUsage = (): OpenAICompatibleUsage => ({
  cachedInputTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const recordOrUndefined = (
  value: unknown
): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined);

const detailNumber = (
  details: Record<string, unknown> | undefined,
  key: string
): number => finiteNumber(details?.[key]) ?? 0;

export const extractOpenAICompatibleUsage = (
  payload: unknown
): OpenAICompatibleUsage => {
  if (!(isRecord(payload) && isRecord(payload.usage))) {
    return emptyUsage();
  }
  const usage = payload.usage;
  const inputTokens =
    finiteNumber(usage.prompt_tokens ?? usage.input_tokens) ?? 0;
  const outputTokens =
    finiteNumber(usage.completion_tokens ?? usage.output_tokens) ?? 0;
  const promptDetails = recordOrUndefined(
    usage.prompt_tokens_details ?? usage.input_tokens_details
  );
  const completionDetails = recordOrUndefined(
    usage.completion_tokens_details ?? usage.output_tokens_details
  );
  const costDetails = recordOrUndefined(usage.cost_details);
  const totalTokens =
    finiteNumber(usage.total_tokens) ?? inputTokens + outputTokens;
  const result: OpenAICompatibleUsage = {
    cachedInputTokens: detailNumber(promptDetails, "cached_tokens"),
    inputTokens,
    outputTokens,
    reasoningTokens: detailNumber(completionDetails, "reasoning_tokens"),
    totalTokens,
  };
  const cost = finiteNumber(usage.cost);
  if (cost !== undefined) {
    result.cost = cost;
  }
  const upstreamInferenceCost = finiteNumber(
    costDetails?.upstream_inference_cost
  );
  if (upstreamInferenceCost !== undefined) {
    result.upstreamInferenceCost = upstreamInferenceCost;
  }
  return result;
};

const sensitiveKey = (key: string): boolean => SENSITIVE_KEY_RE.test(key);

const redactString = (value: string, credential?: string): string => {
  let redacted = value.replace(/Bearer\s+[^\s,;"']+/gi, `Bearer ${REDACTED}`);
  if (credential) {
    redacted = redacted.split(credential).join(REDACTED);
    try {
      const encodedCredential = encodeURIComponent(credential);
      redacted = redacted.split(encodedCredential).join(REDACTED);
    } catch {
      // encodeURIComponent only throws for malformed surrogate input.
    }
  }
  return redacted;
};

const redact = (value: unknown, credential?: string): unknown => {
  if (typeof value === "string") {
    return redactString(value, credential);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, credential));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sensitiveKey(key) ? REDACTED : redact(entry, credential),
    ])
  );
};

const redactUrl = (url: string, credential?: string): string => {
  try {
    const parsed = new URL(url);
    if (parsed.username) {
      parsed.username = REDACTED;
    }
    if (parsed.password) {
      parsed.password = REDACTED;
    }
    for (const key of parsed.searchParams.keys()) {
      if (sensitiveKey(key)) {
        parsed.searchParams.set(key, REDACTED);
      }
    }
    return redactString(parsed.toString(), credential);
  } catch {
    return redactString(url, credential);
  }
};

const emitTrace = (
  hook: OpenAICompatibleChatRequest["onTrace"],
  event: OpenAICompatibleTraceEvent,
  credential?: string
): void => {
  if (!hook) {
    return;
  }
  try {
    hook(redact(event, credential) as OpenAICompatibleTraceEvent);
  } catch {
    // Observability is best-effort and cannot change provider behavior.
  }
};

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  maximum: number
): number => {
  if (!(typeof value === "number" && Number.isFinite(value))) {
    return fallback;
  }
  return Math.min(maximum, Math.max(0, Math.floor(value)));
};

const positiveDelay = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;

const retryableStatus = (status: number): boolean =>
  status === 429 || (status >= 500 && status <= 599);

const retryAfterMs = (
  header: string | null,
  now: number
): number | undefined => {
  if (!header) {
    return undefined;
  }
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const date = Date.parse(header);
  if (!Number.isFinite(date)) {
    return undefined;
  }
  return Math.max(0, date - now);
};

const readResponse = async (
  response: Response
): Promise<{ payload?: unknown; text: string }> => {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return { text };
  }
  try {
    return { payload: JSON.parse(text), text };
  } catch {
    return { text };
  }
};

const parseToolCalls = (
  value: unknown
): OpenAICompatibleToolCall[] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const calls: OpenAICompatibleToolCall[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      entry.type !== "function" ||
      !isRecord(entry.function) ||
      typeof entry.function.name !== "string" ||
      typeof entry.function.arguments !== "string"
    ) {
      return undefined;
    }
    calls.push({
      function: {
        arguments: entry.function.arguments,
        name: entry.function.name,
      },
      id: entry.id,
      type: "function",
    });
  }
  return calls;
};

interface ParsedCompletion {
  finishReason: string | null;
  id?: string;
  message: Extract<OpenAICompatibleMessage, { role: "assistant" }>;
  model: string;
}

const parseCompletion = (payload: unknown): ParsedCompletion | undefined => {
  if (!(isRecord(payload) && Array.isArray(payload.choices))) {
    return undefined;
  }
  const choice = payload.choices[0];
  if (!(isRecord(choice) && isRecord(choice.message))) {
    return undefined;
  }
  const rawContent = choice.message.content;
  let content: string | null;
  if (typeof rawContent === "string") {
    content = rawContent;
  } else if (rawContent === null) {
    content = null;
  } else {
    return undefined;
  }
  const toolCalls = parseToolCalls(choice.message.tool_calls);
  if (choice.message.tool_calls !== undefined && toolCalls === undefined) {
    return undefined;
  }
  if ((content === null || content.length === 0) && !toolCalls?.length) {
    return undefined;
  }
  const message: Extract<OpenAICompatibleMessage, { role: "assistant" }> = {
    content,
    role: "assistant",
  };
  if (toolCalls) {
    message.tool_calls = toolCalls;
  }
  const parsed: ParsedCompletion = {
    finishReason:
      typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    message,
    model: typeof payload.model === "string" ? payload.model : "",
  };
  if (typeof payload.id === "string") {
    parsed.id = payload.id;
  }
  return parsed;
};

const errorMessage = (payload: unknown, fallback: string): string => {
  if (isRecord(payload) && isRecord(payload.error)) {
    const message = payload.error.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return fallback;
};

const wait = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

const requestBody = (
  request: OpenAICompatibleChatRequest
): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    messages: request.messages,
    model: request.model,
    stream: false,
  };
  if (request.maxTokens !== undefined) {
    body.max_tokens = request.maxTokens;
  }
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (request.tools !== undefined) {
    body.tools = request.tools;
  }
  if (request.toolChoice !== undefined) {
    body.tool_choice = request.toolChoice;
  }
  if (request.provider !== undefined) {
    body.provider = request.provider;
  }
  return body;
};

interface ProviderResponse {
  ok: true;
  payload?: unknown;
  response: Response;
  text: string;
}

interface ProviderFailure {
  error: OpenAICompatibleError;
  ok: false;
}

type ProviderAttempt = ProviderFailure | ProviderResponse;

interface AttemptRuntime {
  fetchFn: typeof fetch;
  now: () => number;
  timeoutMs: number;
}

const fetchErrorMessage = (
  timedOut: boolean,
  timeoutMs: number,
  error: unknown
): string => {
  if (timedOut) {
    return `OpenAI-compatible request timed out after ${timeoutMs}ms`;
  }
  return error instanceof Error ? error.message : String(error);
};

const performAttempt = async (
  request: OpenAICompatibleChatRequest,
  body: Record<string, unknown>,
  attempt: number,
  runtime: AttemptRuntime
): Promise<ProviderAttempt> => {
  const attemptStartedAt = runtime.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtime.timeoutMs);
  emitTrace(
    request.onTrace,
    {
      attempt,
      request: body,
      timestamp: new Date(runtime.now()).toISOString(),
      type: "request",
      url: redactUrl(request.endpoint, request.apiKey),
    },
    request.apiKey
  );

  let response: Response;
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (request.apiKey) {
      headers.Authorization = `Bearer ${request.apiKey}`;
    }
    response = await runtime.fetchFn(request.endpoint, {
      body: JSON.stringify(body),
      headers,
      method: "POST",
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = controller.signal.aborted;
    const message = fetchErrorMessage(timedOut, runtime.timeoutMs, error);
    emitTrace(
      request.onTrace,
      {
        attempt,
        error: message,
        timestamp: new Date(runtime.now()).toISOString(),
        type: "error",
      },
      request.apiKey
    );
    return {
      error: {
        kind: timedOut ? "timeout" : "network",
        message: redactString(message, request.apiKey),
        retryable: false,
      },
      ok: false,
    };
  } finally {
    clearTimeout(timer);
  }

  const { payload, text } = await readResponse(response);
  emitTrace(
    request.onTrace,
    {
      attempt,
      durationMs: Math.max(0, runtime.now() - attemptStartedAt),
      response: payload ?? text.slice(0, MAX_ERROR_BODY_CHARS),
      status: response.status,
      timestamp: new Date(runtime.now()).toISOString(),
      type: "response",
    },
    request.apiKey
  );
  return { ok: true, payload, response, text };
};

export const openAICompatibleChat = async (
  request: OpenAICompatibleChatRequest,
  dependencies: OpenAICompatibleDependencies = {}
): Promise<OpenAICompatibleChatResult> => {
  const fetchFn = dependencies.fetchFn ?? fetch;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? wait;
  const timeoutMs = positiveDelay(request.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxRetries = boundedInteger(
    request.maxRetries,
    DEFAULT_MAX_RETRIES,
    MAX_RETRIES
  );
  const retryBaseDelayMs = positiveDelay(
    request.retryBaseDelayMs,
    DEFAULT_RETRY_BASE_DELAY_MS
  );
  const maxRetryDelayMs = positiveDelay(
    request.maxRetryDelayMs,
    DEFAULT_MAX_RETRY_DELAY_MS
  );
  const body = requestBody(request);
  const startedAt = now();
  let attempts = 0;

  while (attempts <= maxRetries) {
    attempts += 1;
    const attempt = await performAttempt(request, body, attempts, {
      fetchFn,
      now,
      timeoutMs,
    });
    if ("error" in attempt) {
      return {
        attempts,
        durationMs: Math.max(0, now() - startedAt),
        error: attempt.error,
        ok: false,
        usage: emptyUsage(),
      };
    }
    const { payload, response, text } = attempt;

    if (!response.ok) {
      const canRetry = retryableStatus(response.status);
      if (canRetry && attempts <= maxRetries) {
        const headerDelay = retryAfterMs(
          response.headers.get("Retry-After"),
          now()
        );
        const exponentialDelay = retryBaseDelayMs * 2 ** (attempts - 1);
        const delayMs = Math.min(
          maxRetryDelayMs,
          headerDelay ?? exponentialDelay
        );
        emitTrace(
          request.onTrace,
          {
            attempt: attempts,
            delayMs,
            status: response.status,
            timestamp: new Date(now()).toISOString(),
            type: "retry",
          },
          request.apiKey
        );
        await sleep(delayMs);
        continue;
      }
      const fallback = `OpenAI-compatible endpoint returned HTTP ${response.status}`;
      return {
        attempts,
        durationMs: Math.max(0, now() - startedAt),
        error: {
          body: redact(
            payload ?? text.slice(0, MAX_ERROR_BODY_CHARS),
            request.apiKey
          ),
          kind: "http",
          message: redactString(
            errorMessage(payload, fallback),
            request.apiKey
          ),
          retryable: canRetry,
          status: response.status,
        },
        ok: false,
        usage: extractOpenAICompatibleUsage(payload),
      };
    }

    if (payload === undefined) {
      return {
        attempts,
        durationMs: Math.max(0, now() - startedAt),
        error: {
          body: redactString(
            text.slice(0, MAX_ERROR_BODY_CHARS),
            request.apiKey
          ),
          kind: "invalid-response",
          message: "OpenAI-compatible endpoint returned invalid JSON",
          retryable: false,
        },
        ok: false,
        usage: emptyUsage(),
      };
    }

    const parsed = parseCompletion(payload);
    if (!parsed) {
      return {
        attempts,
        durationMs: Math.max(0, now() - startedAt),
        error: {
          body: redact(payload, request.apiKey),
          kind: "invalid-response",
          message: "OpenAI-compatible response did not contain a valid choice",
          retryable: false,
        },
        ok: false,
        usage: extractOpenAICompatibleUsage(payload),
      };
    }

    return {
      ...parsed,
      attempts,
      durationMs: Math.max(0, now() - startedAt),
      model: parsed.model || request.model,
      ok: true,
      usage: extractOpenAICompatibleUsage(payload),
    };
  }

  throw new Error("unreachable retry state");
};
