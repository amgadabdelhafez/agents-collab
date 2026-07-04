import type {
  BabysitterAgentState,
  BabysitterVerdict,
  JudgeFailureReason,
  JudgeOutcome,
  JudgeRequest,
} from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TOKENS = 1200;
const TEMPERATURE = 0;
const MAX_HOOK_EVENTS = 20;
const MAX_PANE_CHARS = 4000;
const MAX_SUMMARY_CHARS = 140;
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const ABORT_ERROR_NAME = "AbortError";

const ALLOWED_STATES: readonly BabysitterAgentState[] = [
  "working",
  "waiting-human",
  "waiting-peer",
  "stuck",
  "crashed",
];

const FALLBACK_VERDICT: BabysitterVerdict = {
  state: "working",
  summary: "",
  confidence: 0,
};

const SYSTEM_PROMPT = [
  "You are a watchdog judging whether a coding agent is making progress or is stuck.",
  "Reply with ONLY a strict JSON object and nothing else (no markdown, no prose):",
  '{"state": "working"|"waiting-human"|"waiting-peer"|"stuck"|"crashed", "summary": "<=140 char one-liner", "confidence": 0..1, "suggestedAction": "<optional>"}',
].join("\n");

interface ChatMessage {
  content: string;
  role: "system" | "user";
}

type JudgeDeps = { fetchFn?: typeof fetch; timeoutMs?: number };

const fallbackOutcome = (reason: JudgeFailureReason): JudgeOutcome => ({
  ok: false,
  reason,
  fallback: { ...FALLBACK_VERDICT },
});

const buildUserPrompt = (req: JudgeRequest): string => {
  const recentHooks = req.hookTail.slice(-MAX_HOOK_EVENTS);
  const paneText = req.paneText.slice(0, MAX_PANE_CHARS);
  return [
    `Agent under watch: ${req.agent}`,
    `Recent hook events (JSON): ${JSON.stringify(recentHooks)}`,
    "Recent pane text (may be truncated):",
    paneText,
  ].join("\n");
};

const buildRequestBody = (req: JudgeRequest): string => {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(req) },
  ];
  return JSON.stringify({
    model: req.model,
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    messages,
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const extractMessageContent = (payload: unknown): string | null => {
  if (!isRecord(payload)) {
    return null;
  }
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const first = choices[0];
  if (!isRecord(first)) {
    return null;
  }
  const message = first.message;
  if (!isRecord(message)) {
    return null;
  }
  const content = message.content;
  return typeof content === "string" ? content : null;
};

const stripThinkBlocks = (text: string): string =>
  text.replace(/<think>[\s\S]*?<\/think>/gi, "");

// Extract the first balanced top-level JSON object substring from arbitrary text.
const extractFirstJsonObject = (text: string): string | null => {
  const start = text.indexOf("{");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
};

const isAllowedState = (value: unknown): value is BabysitterAgentState =>
  typeof value === "string" &&
  (ALLOWED_STATES as readonly string[]).includes(value);

const clampConfidence = (value: unknown): number => {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  if (num < 0) {
    return 0;
  }
  if (num > 1) {
    return 1;
  }
  return num;
};

const coerceSummary = (value: unknown): string => {
  const summary = typeof value === "string" ? value : "";
  return summary.slice(0, MAX_SUMMARY_CHARS);
};

const coerceSuggestedAction = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const parseVerdict = (content: string): BabysitterVerdict | null => {
  const cleaned = stripThinkBlocks(content);
  const jsonText = extractFirstJsonObject(cleaned);
  if (jsonText === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isAllowedState(parsed.state)) {
    return null;
  }
  const verdict: BabysitterVerdict = {
    state: parsed.state,
    summary: coerceSummary(parsed.summary),
    confidence: clampConfidence(parsed.confidence),
  };
  const suggestedAction = coerceSuggestedAction(parsed.suggestedAction);
  if (suggestedAction !== undefined) {
    verdict.suggestedAction = suggestedAction;
  }
  return verdict;
};

const isAbortError = (error: unknown): boolean =>
  isRecord(error) && error.name === ABORT_ERROR_NAME;

export const judgeAgent = async (
  req: JudgeRequest,
  deps?: JudgeDeps
): Promise<JudgeOutcome> => {
  const fetchFn = deps?.fetchFn ?? fetch;
  const timeoutMs = deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchFn(`${req.url}${CHAT_COMPLETIONS_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: buildRequestBody(req),
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      return fallbackOutcome("timeout");
    }
    return fallbackOutcome("unreachable");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return fallbackOutcome("malformed");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return fallbackOutcome("malformed");
  }

  const content = extractMessageContent(payload);
  if (content === null || content.length === 0) {
    return fallbackOutcome("malformed");
  }

  const verdict = parseVerdict(content);
  if (verdict === null) {
    return fallbackOutcome("malformed");
  }

  return { ok: true, verdict };
};
