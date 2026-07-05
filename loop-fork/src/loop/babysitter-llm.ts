import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Agent,
  BabysitterAgentState,
  BabysitterVerdict,
  JudgeFailureReason,
  JudgeOutcome,
  JudgeRequest,
  LocalLlmUsage,
  SummaryRequest,
  SummaryResult,
  WaitingRequest,
  WaitingResult,
} from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
export const LOCAL_LLM_JUDGE_MAX_TOKENS = 1200;
export const LOCAL_LLM_TEMPERATURE = 0;
const MAX_HOOK_EVENTS = 20;
const MAX_PANE_CHARS = 4000;
const MAX_SUMMARY_CHARS = 140;
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const ABORT_ERROR_NAME = "AbortError";

const ALLOWED_STATES: readonly BabysitterAgentState[] = [
  "working",
  "waiting-human",
  "waiting-peer",
  "limited",
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
  '{"state": "working"|"waiting-human"|"waiting-peer"|"limited"|"stuck"|"crashed", "summary": "<=140 char one-liner", "confidence": 0..1, "suggestedAction": "<optional>"}',
].join("\n");

interface ChatMessage {
  content: string;
  role: "system" | "user";
}

interface ChatRequestBody {
  max_tokens: number;
  messages: ChatMessage[];
  model: string;
  temperature: number;
}

interface JudgeDeps {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

type LlmTracePurpose = "judge" | "summary" | "waiting";

interface TraceMeta {
  agent?: Agent;
  model: string;
  purpose: LlmTracePurpose;
  url: string;
}

const emptyUsage = (calls = 0): LocalLlmUsage => ({
  cachedInputTokens: 0,
  calls,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

const fallbackOutcome = (reason: JudgeFailureReason): JudgeOutcome => ({
  ok: false,
  reason,
  fallback: { ...FALLBACK_VERDICT },
  tokens: 0,
  usage: emptyUsage(1),
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

const buildJudgeRequestBody = (req: JudgeRequest): ChatRequestBody => {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(req) },
  ];
  return {
    model: req.model,
    temperature: LOCAL_LLM_TEMPERATURE,
    max_tokens: LOCAL_LLM_JUDGE_MAX_TOKENS,
    messages,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const appendTrace = (traceFile: string | undefined, record: unknown): void => {
  if (!traceFile) {
    return;
  }
  try {
    mkdirSync(dirname(traceFile), { recursive: true });
    appendFileSync(traceFile, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Tracing is diagnostic only; it must never affect babysitter behavior.
  }
};

const traceRequest = (
  traceFile: string | undefined,
  meta: TraceMeta,
  request: ChatRequestBody
): string | undefined => {
  if (!traceFile) {
    return undefined;
  }
  const callId = randomUUID();
  appendTrace(traceFile, {
    callId,
    direction: "to-mlx",
    kind: "llm-trace",
    phase: "request",
    request,
    ts: new Date().toISOString(),
    ...meta,
  });
  return callId;
};

const traceResponse = (
  traceFile: string | undefined,
  callId: string | undefined,
  meta: TraceMeta,
  response: Response,
  responseText: string,
  payload?: unknown
): void => {
  if (!traceFile || !callId) {
    return;
  }
  appendTrace(traceFile, {
    callId,
    direction: "from-mlx",
    kind: "llm-trace",
    ok: response.ok,
    phase: "response",
    response: payload ?? responseText,
    status: response.status,
    ts: new Date().toISOString(),
    usage: payload === undefined ? undefined : extractUsage(payload),
    ...meta,
  });
};

const traceError = (
  traceFile: string | undefined,
  callId: string | undefined,
  meta: TraceMeta,
  error: unknown
): void => {
  if (!traceFile || !callId) {
    return;
  }
  appendTrace(traceFile, {
    callId,
    direction: "from-mlx",
    error: error instanceof Error ? error.message : String(error),
    kind: "llm-trace",
    phase: "error",
    ts: new Date().toISOString(),
    ...meta,
  });
};

const readJsonPayload = async (
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

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const ESTIMATED_CHARS_PER_TOKEN = 4;

const estimateTokens = (text: string): number =>
  text.trim().length > 0
    ? Math.max(1, Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN))
    : 0;

const estimateInputTokens = (body: ChatRequestBody): number =>
  body.messages.reduce(
    (sum, message) => sum + estimateTokens(message.content),
    0
  );

const extractUsage = (payload: unknown): LocalLlmUsage => {
  if (!isRecord(payload)) {
    return emptyUsage(1);
  }
  const usage = payload.usage;
  if (!isRecord(usage)) {
    return emptyUsage(1);
  }
  const outputTokens = num(usage.completion_tokens ?? usage.output_tokens);
  const explicitInput = num(usage.prompt_tokens ?? usage.input_tokens);
  const promptDetails = usage.prompt_tokens_details ?? usage.input_tokens_details;
  const cachedInputTokens = isRecord(promptDetails)
    ? num(promptDetails.cached_tokens)
    : 0;
  const totalTokens =
    num(usage.total_tokens) || explicitInput + outputTokens;
  const inputTokens =
    explicitInput || Math.max(0, totalTokens - outputTokens);
  return {
    cachedInputTokens,
    calls: 1,
    inputTokens,
    outputTokens,
    totalTokens,
  };
};

const usageWithFallback = (
  payload: unknown,
  body: ChatRequestBody,
  content: string
): LocalLlmUsage => {
  const usage = extractUsage(payload);
  if (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.totalTokens > 0
  ) {
    return usage;
  }
  const inputTokens = estimateInputTokens(body);
  const outputTokens = estimateTokens(content);
  return {
    cachedInputTokens: 0,
    calls: 1,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
};

const stripThinkBlocks = (text: string): string =>
  text.replace(/<think>[\s\S]*?<\/think>/gi, "");

interface ScanState {
  depth: number;
  escaped: boolean;
  inString: boolean;
}

// Advance string-literal scanning state for one character inside a JSON string.
const scanStringChar = (state: ScanState, char: string): void => {
  if (state.escaped) {
    state.escaped = false;
    return;
  }
  if (char === "\\") {
    state.escaped = true;
    return;
  }
  if (char === '"') {
    state.inString = false;
  }
};

// Extract the first balanced top-level JSON object substring from arbitrary text.
const extractFirstJsonObject = (text: string): string | null => {
  const start = text.indexOf("{");
  if (start === -1) {
    return null;
  }
  const state: ScanState = { depth: 0, escaped: false, inString: false };
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (state.inString) {
      scanStringChar(state, char);
      continue;
    }
    if (char === '"') {
      state.inString = true;
    } else if (char === "{") {
      state.depth += 1;
    } else if (char === "}") {
      state.depth -= 1;
      if (state.depth === 0) {
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
  if (!(isRecord(parsed) && isAllowedState(parsed.state))) {
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
  const body = buildJudgeRequestBody(req);
  const traceMeta: TraceMeta = {
    agent: req.agent,
    model: req.model,
    purpose: "judge",
    url: req.url,
  };
  const callId = traceRequest(req.traceFile, traceMeta, body);

  let response: Response;
  try {
    response = await fetchFn(`${req.url}${CHAT_COMPLETIONS_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    traceError(req.traceFile, callId, traceMeta, error);
    if (isAbortError(error)) {
      return fallbackOutcome("timeout");
    }
    return fallbackOutcome("unreachable");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const { payload, text } = await readJsonPayload(response);
    traceResponse(req.traceFile, callId, traceMeta, response, text, payload);
    return fallbackOutcome("malformed");
  }

  const { payload, text } = await readJsonPayload(response);
  traceResponse(req.traceFile, callId, traceMeta, response, text, payload);
  if (payload === undefined) {
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

  const usage = usageWithFallback(payload, body, content);
  return { ok: true, tokens: usage.totalTokens, usage, verdict };
};

const SUMMARY_SYSTEM_PROMPT = [
  "You are a technical lead observing a live pair-programming session between two",
  "AI coding agents (Claude and Codex) working the same task together. You are",
  "given the project docs, the human's verbatim instructions this session,",
  "summaries of prior sessions, and each agent's recent actions and terminal",
  "output. Write a briefing for someone glancing at the pane who wants to know",
  "exactly what is going on. Use plain text, no markdown symbols. Output EXACTLY",
  "these four labeled sections, each on its own line, in this order:",
  "Project: <1 line — what this codebase/project is>",
  "Objective: <1-2 lines — what the human asked for this session, specifically>",
  "Progress: <3-5 lines — concrete work done: files, tests, decisions, bugs>",
  "Next: <2-3 lines — the most likely next steps / what remains>",
  "Be specific about code, filenames, and tasks. Infer next steps from the",
  "trajectory. Do not describe whether the agents are idle or active.",
].join(" ");

export const LOCAL_LLM_SUMMARY_MAX_TOKENS = 3200;
const SUMMARY_PANE_CHARS = 1800;
const SUMMARY_ACTIONS = 24;
const MAX_PROMPT_HUMAN_MESSAGES = 16;
// mlx serves one request at a time, so a summary can queue behind a judge
// call; give it a generous timeout (it is a background board element).
const SUMMARY_TIMEOUT_MS = 120_000;
const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/gi;

const agentSection = (a: SummaryRequest["agents"][number]): string =>
  [
    `## agent: ${a.agent}`,
    `recent actions: ${a.lastActions.slice(-SUMMARY_ACTIONS).join(" | ") || "—"}`,
    "terminal:",
    a.paneText.slice(-SUMMARY_PANE_CHARS),
  ].join("\n");

const buildSummaryPrompt = (req: SummaryRequest): string => {
  const blocks: string[] = [];
  if (req.projectContext) {
    blocks.push(`# PROJECT DOCS\n${req.projectContext}`);
  }
  if (req.humanMessages && req.humanMessages.length > 0) {
    const lines = req.humanMessages
      .slice(-MAX_PROMPT_HUMAN_MESSAGES)
      .map((message) => `- ${message}`)
      .join("\n");
    blocks.push(
      `# HUMAN INSTRUCTIONS THIS SESSION (oldest → newest)\n${lines}`
    );
  }
  if (req.priorSummaries && req.priorSummaries.length > 0) {
    const lines = req.priorSummaries
      .map((summary, i) => `[prior session ${i + 1}]\n${summary}`)
      .join("\n\n");
    blocks.push(`# PRIOR SESSIONS (newest first)\n${lines}`);
  }
  blocks.push(
    `# LIVE AGENT STATE\n${req.agents.map(agentSection).join("\n\n")}`
  );
  return blocks.join("\n\n");
};

// Ask the local LLM for a short natural-language session summary.
export const summarizeSession = async (
  req: SummaryRequest,
  deps?: JudgeDeps
): Promise<SummaryResult> => {
  const fetchFn = deps?.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    deps?.timeoutMs ?? SUMMARY_TIMEOUT_MS
  );
  const body: ChatRequestBody = {
    max_tokens: LOCAL_LLM_SUMMARY_MAX_TOKENS,
    messages: [
      { content: SUMMARY_SYSTEM_PROMPT, role: "system" },
      { content: buildSummaryPrompt(req), role: "user" },
    ],
    model: req.model,
    temperature: LOCAL_LLM_TEMPERATURE,
  };
  const traceMeta: TraceMeta = {
    model: req.model,
    purpose: "summary",
    url: req.url,
  };
  const callId = traceRequest(req.traceFile, traceMeta, body);
  try {
    const response = await fetchFn(`${req.url}${CHAT_COMPLETIONS_PATH}`, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: controller.signal,
    });
    if (!response.ok) {
      const { payload, text } = await readJsonPayload(response);
      traceResponse(req.traceFile, callId, traceMeta, response, text, payload);
      return { text: "", tokens: 0, usage: emptyUsage(1) };
    }
    const { payload, text } = await readJsonPayload(response);
    traceResponse(req.traceFile, callId, traceMeta, response, text, payload);
    if (payload === undefined) {
      return { text: "", tokens: 0, usage: emptyUsage(1) };
    }
    const content = extractMessageContent(payload) ?? "";
    const summaryText = content.replace(THINK_BLOCK_RE, "").trim();
    const usage = usageWithFallback(payload, body, summaryText);
    return {
      text: summaryText,
      tokens: usage.totalTokens,
      usage,
    };
  } catch (error) {
    traceError(req.traceFile, callId, traceMeta, error);
    return { text: "", tokens: 0, usage: emptyUsage(1) };
  } finally {
    clearTimeout(timer);
  }
};

const WAITING_SYSTEM_PROMPT = [
  "Two AI coding agents share one task and have both gone idle at the same time.",
  "From their recent actions and terminal panes, decide whether they are BLOCKED",
  "waiting for the human to answer, decide, or approve something — as opposed to",
  "having simply finished the work or paused between steps. Reply with ONLY a",
  "strict JSON object, no prose:",
  '{"waiting": true|false, "ask": "<one line, <=100 chars: what they need from the',
  'human; empty string if not waiting>"}.',
  "Be conservative: set waiting=true only if a pane clearly shows a question or",
  "request directed at the human.",
].join(" ");

export const LOCAL_LLM_WAITING_MAX_TOKENS = 1200;
const WAITING_ASK_MAX = 100;

const buildWaitingPrompt = (req: WaitingRequest): string =>
  req.agents.map(agentSection).join("\n\n");

const asWaiting = (content: string, usage: LocalLlmUsage): WaitingResult => {
  const json = extractFirstJsonObject(stripThinkBlocks(content));
  if (!json) {
    return { ask: "", tokens: usage.totalTokens, usage, waiting: false };
  }
  try {
    const parsed = JSON.parse(json) as { ask?: unknown; waiting?: unknown };
    const waiting = parsed.waiting === true;
    const ask =
      waiting && typeof parsed.ask === "string"
        ? parsed.ask.trim().slice(0, WAITING_ASK_MAX)
        : "";
    return { ask, tokens: usage.totalTokens, usage, waiting };
  } catch {
    return { ask: "", tokens: usage.totalTokens, usage, waiting: false };
  }
};

// Ask the local LLM whether both idle agents are actually blocked on the human,
// and (if so) a one-line description of what they need. Best-effort: any failure
// yields waiting=false so we do not raise a false alert.
export const assessWaiting = async (
  req: WaitingRequest,
  deps?: JudgeDeps
): Promise<WaitingResult> => {
  const fetchFn = deps?.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
  const body: ChatRequestBody = {
    max_tokens: LOCAL_LLM_WAITING_MAX_TOKENS,
    messages: [
      { content: WAITING_SYSTEM_PROMPT, role: "system" },
      { content: buildWaitingPrompt(req), role: "user" },
    ],
    model: req.model,
    temperature: LOCAL_LLM_TEMPERATURE,
  };
  const traceMeta: TraceMeta = {
    model: req.model,
    purpose: "waiting",
    url: req.url,
  };
  const callId = traceRequest(req.traceFile, traceMeta, body);
  try {
    const response = await fetchFn(`${req.url}${CHAT_COMPLETIONS_PATH}`, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: controller.signal,
    });
    if (!response.ok) {
      const { payload, text } = await readJsonPayload(response);
      traceResponse(req.traceFile, callId, traceMeta, response, text, payload);
      return { ask: "", tokens: 0, usage: emptyUsage(1), waiting: false };
    }
    const { payload, text } = await readJsonPayload(response);
    traceResponse(req.traceFile, callId, traceMeta, response, text, payload);
    if (payload === undefined) {
      return { ask: "", tokens: 0, usage: emptyUsage(1), waiting: false };
    }
    const content = extractMessageContent(payload) ?? "";
    return asWaiting(content, usageWithFallback(payload, body, content));
  } catch (error) {
    traceError(req.traceFile, callId, traceMeta, error);
    return { ask: "", tokens: 0, usage: emptyUsage(1), waiting: false };
  } finally {
    clearTimeout(timer);
  }
};
