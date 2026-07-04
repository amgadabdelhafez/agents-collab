import type {
  BabysitterAgentState,
  BabysitterVerdict,
  JudgeFailureReason,
  JudgeOutcome,
  JudgeRequest,
  SummaryRequest,
  SummaryResult,
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

interface JudgeDeps {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

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

const extractTokens = (payload: unknown): number => {
  if (!isRecord(payload)) {
    return 0;
  }
  const usage = payload.usage;
  if (!isRecord(usage)) {
    return 0;
  }
  const total = usage.total_tokens ?? usage.completion_tokens;
  return typeof total === "number" ? total : 0;
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

  return { ok: true, tokens: extractTokens(payload), verdict };
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

const SUMMARY_MAX_TOKENS = 3200;
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
  try {
    const response = await fetchFn(`${req.url}${CHAT_COMPLETIONS_PATH}`, {
      body: JSON.stringify({
        max_tokens: SUMMARY_MAX_TOKENS,
        messages: [
          { content: SUMMARY_SYSTEM_PROMPT, role: "system" },
          { content: buildSummaryPrompt(req), role: "user" },
        ],
        model: req.model,
        temperature: TEMPERATURE,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: controller.signal,
    });
    if (!response.ok) {
      return { text: "", tokens: 0 };
    }
    const payload = await response.json();
    const content = extractMessageContent(payload) ?? "";
    return {
      text: content.replace(THINK_BLOCK_RE, "").trim(),
      tokens: extractTokens(payload),
    };
  } catch {
    return { text: "", tokens: 0 };
  } finally {
    clearTimeout(timer);
  }
};
