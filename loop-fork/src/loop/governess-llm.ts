import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { completePiText } from "./pi-runtime";
import type {
  Agent,
  GovernessAgentState,
  GovernessVerdict,
  JudgeFailureReason,
  JudgeOutcome,
  JudgeRequest,
  LocalLlmUsage,
  PaneLabelRequest,
  PaneLabelResult,
  RoleBalanceRequest,
  RoleBalanceResult,
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

const ALLOWED_STATES: readonly GovernessAgentState[] = [
  "working",
  "waiting-human",
  "waiting-peer",
  "limited",
  "stuck",
  "crashed",
];

const FALLBACK_VERDICT: GovernessVerdict = {
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

const piChatFetch = (async (
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> => {
  const body = JSON.parse(String(init?.body ?? "{}")) as ChatRequestBody;
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url
  );
  const endpoint = `${url.origin}${url.pathname}`;
  const systemPrompt =
    body.messages.find((message) => message.role === "system")?.content ?? "";
  const userPrompt = body.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n\n");
  const completion = await completePiText({
    maxTokens: body.max_tokens,
    provider: {
      endpoint,
      model: body.model,
      provider: "nanny",
    },
    ...(init?.signal ? { signal: init.signal } : {}),
    systemPrompt,
    temperature: body.temperature,
    timeoutMs: 10 * 60_000,
    userPrompt,
  });
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: completion.text, role: "assistant" } }],
      model: completion.model,
      pi_version: completion.piVersion,
      usage: {
        completion_tokens: completion.usage.outputTokens,
        prompt_tokens: completion.usage.inputTokens,
        prompt_tokens_details: {
          cached_tokens: completion.usage.cachedInputTokens,
        },
        total_tokens: completion.usage.totalTokens,
      },
    }),
    { headers: { "Content-Type": "application/json" }, status: 200 }
  );
}) as typeof fetch;

type LlmTracePurpose =
  | "judge"
  | "pane-label"
  | "role-balance"
  | "summary"
  | "waiting";

interface TraceMeta {
  agent?: Agent;
  harness: "injected-http" | "pi-sdk";
  model: string;
  purpose: LlmTracePurpose;
  url: string;
}

const traceHarness = (deps: JudgeDeps | undefined): TraceMeta["harness"] =>
  deps?.fetchFn ? "injected-http" : "pi-sdk";

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
    // Tracing is diagnostic only; it must never affect governess behavior.
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
  if (!(traceFile && callId)) {
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
  if (!(traceFile && callId)) {
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
  const promptDetails =
    usage.prompt_tokens_details ?? usage.input_tokens_details;
  const cachedInputTokens = isRecord(promptDetails)
    ? num(promptDetails.cached_tokens)
    : 0;
  const totalTokens = num(usage.total_tokens) || explicitInput + outputTokens;
  const inputTokens = explicitInput || Math.max(0, totalTokens - outputTokens);
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

const isAllowedState = (value: unknown): value is GovernessAgentState =>
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

const parseVerdict = (content: string): GovernessVerdict | null => {
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
  const verdict: GovernessVerdict = {
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
  const fetchFn = deps?.fetchFn ?? piChatFetch;
  const timeoutMs = deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const body = buildJudgeRequestBody(req);
  const traceMeta: TraceMeta = {
    agent: req.agent,
    harness: traceHarness(deps),
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
  const fetchFn = deps?.fetchFn ?? piChatFetch;
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
    harness: traceHarness(deps),
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

const PANE_LABEL_SYSTEM_PROMPT = [
  "You label terminal panes for a pair of AI coding agents (Claude and Codex).",
  "For each agent, from their recent actions and terminal output, write a short",
  "2-4 word task label naming WHAT they are working on right now — a noun phrase",
  "like a task chip (e.g. 'auth refactor', 'writing tests', 'tmux pane labels').",
  "Do NOT describe their status (not 'working', 'idle', 'waiting'), no verbs of",
  "state, no punctuation, no filenames unless that is the clearest label. Reply",
  "with ONLY a strict JSON object mapping each agent name to its label, nothing",
  'else: {"claude": "<label>", "codex": "<label>"}.',
].join(" ");

// Reasoning models (e.g. Qwen3) spend ~1800 tokens in a <think> block before
// the JSON when reasoning over full panes, so this must be generous (matching
// the summary budget) or the labels get truncated away entirely.
export const LOCAL_LLM_PANE_LABEL_MAX_TOKENS = 3200;
const PANE_LABEL_MAX_CHARS = 28;
const PANE_LABEL_PANE_CHARS = 1400;
// mlx serves one request at a time, so this label call routinely queues behind
// a same-tick summary (and judge/waiting) call; give it a generous timeout to
// match, or it aborts in the queue and yields no labels.
const PANE_LABEL_TIMEOUT_MS = 120_000;

const buildPaneLabelPrompt = (req: PaneLabelRequest): string =>
  req.agents
    .map((a) =>
      [
        `## agent: ${a.agent}`,
        `recent actions: ${a.lastActions.slice(-SUMMARY_ACTIONS).join(" | ") || "—"}`,
        "terminal:",
        a.paneText.slice(-PANE_LABEL_PANE_CHARS),
      ].join("\n")
    )
    .join("\n\n");

const coercePaneLabel = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const label = value
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PANE_LABEL_MAX_CHARS);
  return label.length > 0 ? label : undefined;
};

const parsePaneLabels = (content: string): Partial<Record<Agent, string>> => {
  const jsonText = extractFirstJsonObject(stripThinkBlocks(content));
  if (jsonText === null) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) {
    return {};
  }
  const labels: Partial<Record<Agent, string>> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const label = coercePaneLabel(value);
    if (label !== undefined) {
      labels[key as Agent] = label;
    }
  }
  return labels;
};

// Ask the local LLM for a short task label per agent, for the tmux pane border.
export const labelPanes = async (
  req: PaneLabelRequest,
  deps?: JudgeDeps
): Promise<PaneLabelResult> => {
  const fetchFn = deps?.fetchFn ?? piChatFetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    deps?.timeoutMs ?? PANE_LABEL_TIMEOUT_MS
  );
  const body: ChatRequestBody = {
    max_tokens: LOCAL_LLM_PANE_LABEL_MAX_TOKENS,
    messages: [
      { content: PANE_LABEL_SYSTEM_PROMPT, role: "system" },
      { content: buildPaneLabelPrompt(req), role: "user" },
    ],
    model: req.model,
    temperature: LOCAL_LLM_TEMPERATURE,
  };
  const traceMeta: TraceMeta = {
    harness: traceHarness(deps),
    model: req.model,
    purpose: "pane-label",
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
    const { payload, text } = await readJsonPayload(response);
    traceResponse(req.traceFile, callId, traceMeta, response, text, payload);
    if (!response.ok || payload === undefined) {
      return { labels: {}, tokens: 0, usage: emptyUsage(1) };
    }
    const content = extractMessageContent(payload) ?? "";
    const labels = parsePaneLabels(content);
    const usage = usageWithFallback(payload, body, content);
    return { labels, tokens: usage.totalTokens, usage };
  } catch (error) {
    traceError(req.traceFile, callId, traceMeta, error);
    return { labels: {}, tokens: 0, usage: emptyUsage(1) };
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
  const fetchFn = deps?.fetchFn ?? piChatFetch;
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
    harness: traceHarness(deps),
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

const ROLE_BALANCE_SYSTEM_PROMPT = [
  "You are scheduling two AI coding agents that share one task.",
  "Usage percentages come from the external usage tracker. Higher sessionPct",
  "or weeklyPct means less quota remains. Decide whether the driver role should",
  "move now to preserve the tighter agent's quota while keeping progress moving.",
  "Hard limits are handled elsewhere; this decision is only for proactive",
  "balancing before a limit is hit. Prefer no switch unless the candidate has",
  "clearly better quota headroom and can continue the current task.",
  "Reply with ONLY a strict JSON object, no prose:",
  '{"switchDriver": true|false, "driver": "<candidate agent id or null>", "confidence": 0..1, "reason": "<=140 chars>"}',
].join(" ");

export const LOCAL_LLM_ROLE_BALANCE_MAX_TOKENS = 1000;
const ROLE_BALANCE_REASON_MAX = 140;

const buildRoleBalancePrompt = (req: RoleBalanceRequest): string =>
  [
    `Current driver: ${req.currentDriver ?? "unknown"}`,
    `Initial driver: ${req.initialDriver ?? "unknown"}`,
    `Candidate driver: ${req.candidateDriver ?? "none"}`,
    req.reasonHint ? `Heuristic reason: ${req.reasonHint}` : "",
    req.summary ? `Session summary:\n${req.summary}` : "",
    `Agents JSON: ${JSON.stringify(req.agents)}`,
  ]
    .filter(Boolean)
    .join("\n");

const ROLE_AGENT_VALUES: readonly Agent[] = [
  "claude",
  "codex",
  "copilot",
  "cursor",
  "gemini",
];

const allowedRoleAgent = (value: unknown): Agent | undefined =>
  typeof value === "string" && ROLE_AGENT_VALUES.includes(value as Agent)
    ? (value as Agent)
    : undefined;

const asRoleBalance = (
  content: string,
  usage: LocalLlmUsage,
  candidateDriver: Agent | undefined
): RoleBalanceResult => {
  const json = extractFirstJsonObject(stripThinkBlocks(content));
  if (!json) {
    return {
      confidence: 0,
      reason: "",
      switchDriver: false,
      tokens: usage.totalTokens,
      usage,
    };
  }
  try {
    const parsed = JSON.parse(json) as {
      confidence?: unknown;
      driver?: unknown;
      reason?: unknown;
      switchDriver?: unknown;
    };
    const parsedDriver = allowedRoleAgent(parsed.driver);
    const driver =
      candidateDriver === undefined || parsedDriver === candidateDriver
        ? parsedDriver
        : undefined;
    const switchDriver = parsed.switchDriver === true && driver !== undefined;
    const reason =
      typeof parsed.reason === "string"
        ? parsed.reason.trim().slice(0, ROLE_BALANCE_REASON_MAX)
        : "";
    return {
      confidence: clampConfidence(parsed.confidence),
      driver,
      reason,
      switchDriver,
      tokens: usage.totalTokens,
      usage,
    };
  } catch {
    return {
      confidence: 0,
      reason: "",
      switchDriver: false,
      tokens: usage.totalTokens,
      usage,
    };
  }
};

export const assessRoleBalance = async (
  req: RoleBalanceRequest,
  deps?: JudgeDeps
): Promise<RoleBalanceResult> => {
  const fetchFn = deps?.fetchFn ?? piChatFetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
  const body: ChatRequestBody = {
    max_tokens: LOCAL_LLM_ROLE_BALANCE_MAX_TOKENS,
    messages: [
      { content: ROLE_BALANCE_SYSTEM_PROMPT, role: "system" },
      { content: buildRoleBalancePrompt(req), role: "user" },
    ],
    model: req.model,
    temperature: LOCAL_LLM_TEMPERATURE,
  };
  const traceMeta: TraceMeta = {
    harness: traceHarness(deps),
    model: req.model,
    purpose: "role-balance",
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
      return {
        confidence: 0,
        reason: "",
        switchDriver: false,
        tokens: 0,
        usage: emptyUsage(1),
      };
    }
    const { payload, text } = await readJsonPayload(response);
    traceResponse(req.traceFile, callId, traceMeta, response, text, payload);
    if (payload === undefined) {
      return {
        confidence: 0,
        reason: "",
        switchDriver: false,
        tokens: 0,
        usage: emptyUsage(1),
      };
    }
    const content = extractMessageContent(payload) ?? "";
    return asRoleBalance(
      content,
      usageWithFallback(payload, body, content),
      req.candidateDriver
    );
  } catch (error) {
    traceError(req.traceFile, callId, traceMeta, error);
    return {
      confidence: 0,
      reason: "",
      switchDriver: false,
      tokens: 0,
      usage: emptyUsage(1),
    };
  } finally {
    clearTimeout(timer);
  }
};
