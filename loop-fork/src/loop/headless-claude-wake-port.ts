import type {
  WakeOutcome,
  WakePort,
  WakeRequest,
} from "./supervisor-wake-driver";

/**
 * Wakes a session by starting a short-lived headless session that sends it a
 * cross-session message, then exits. This is the only path on this host
 * observed to resume an idle session; the messaging tool has no CLI
 * subcommand, so anything outside a session reaches it this way.
 *
 * Success is read from the TOOL RESULT, never from the model's prose. Review
 * found (2026-09-20) that matching the word SENT in stdout also matches
 * "NOT SENT" and any narrative quoting it, and that a model-authored marker is
 * not evidence the tool ran at all: a session can exit 0 having sent nothing.
 * So this parses the structured event stream for the send tool's own result.
 *
 * What a success here means, precisely: the message REACHED the recipient
 * session and is queued for it. It does not mean the recipient read it, acted
 * on it, or acknowledged anything — a peer in another permission mode may hold
 * it for its user, and nothing reports back for desktop, cloud or remote peers.
 */
const SEND_TOOL = "SendMessage";
const DIAGNOSTIC_LIMIT = 160;
const SINGLE_QUOTE_RE = /'/gu;

/**
 * POSIX single-quote escaping, so a mailbox root containing spaces, or a
 * recipient containing an apostrophe, produces a command the recipient can
 * actually run. Stripping quotes instead would silently corrupt a valid path.
 */
export const shellQuote = (value: string): string =>
  `'${value.replace(SINGLE_QUOTE_RE, "'\\''")}'`;

export interface HeadlessRunResult {
  // True when stopping the child's process group failed for a reason other
  // than it already being gone: a leak worth surfacing, not a silent success.
  cleanupFailed?: boolean;
  code: number;
  stderr: string;
  stdout: string;
  // True when the runner stopped the child on its own deadline.
  timedOut?: boolean;
}

export interface HeadlessClaudeWakePortOptions {
  claudeBin?: string;
  log?: (line: string) => void;
  probe?: (sessionName: string) => Promise<"busy" | "idle" | "unknown">;
  run: (input: {
    argv: readonly string[];
    timeoutMs: number;
  }) => Promise<HeadlessRunResult>;
  // A wake that cannot finish promptly is a failed wake, not a hung service.
  timeoutMs?: number;
}

/**
 * The notice names the recipient, the exact key, and the command that reads
 * THIS recipient's mailbox. A generic instruction is not actionable: the
 * recipient id and mailbox root are what make it runnable.
 */
export const wakeNoticeFor = (request: WakeRequest): string => {
  const id = shellQuote(request.recipient);
  const root = shellQuote(request.mailboxRoot);
  return [
    `You have ${request.unread} unacknowledged message(s) as ${request.recipient}.`,
    `Oldest is ${request.unreadKey}, delivered ${request.oldestUnreadAt}.`,
    `Read them with: loop mailbox receive --id ${id} --root ${root}`,
    `Then acknowledge what you handled: loop mailbox ack --id ${id} --root ${root} --key ${shellQuote(request.unreadKey)}`,
    "This notice is a trigger only: nothing has been acknowledged on your behalf.",
  ].join(" ");
};

const bounded = (value: string): string =>
  value.trim().replace(/\s+/gu, " ").slice(0, DIAGNOSTIC_LIMIT);

interface SendEvidence {
  failure?: string;
  msgId?: string;
  sawSendTool: boolean;
  success: boolean;
}

interface PendingSend {
  id: string;
  to: unknown;
}

/**
 * Reads the event stream for the send tool's own result, bound to the exact
 * invocation that produced it.
 *
 * Review found (2026-09-20) that accepting any later tool result once a send
 * had been seen let an UNRELATED tool's success stand in as a delivery
 * receipt. So a result counts only when its `tool_use_id` matches the send's
 * own id, and only when that send was addressed to the session we asked for:
 * a message delivered to the wrong peer is not a wake for this one.
 */
export const readSendEvidence = (
  stdout: string,
  expectedTo: string
): SendEvidence => {
  const evidence: SendEvidence = { sawSendTool: false, success: false };
  let pending: PendingSend | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const blocks = (event as { message?: { content?: unknown } })?.message
      ?.content;
    if (!Array.isArray(blocks)) {
      continue;
    }
    for (const block of blocks) {
      pending = readBlock(block, evidence, pending, expectedTo);
    }
  }
  return evidence;
};

const readBlock = (
  block: unknown,
  evidence: SendEvidence,
  pending: PendingSend | undefined,
  expectedTo: string
): PendingSend | undefined => {
  if (typeof block !== "object" || block === null) {
    return pending;
  }
  const typed = block as {
    content?: unknown;
    id?: unknown;
    input?: { to?: unknown };
    is_error?: boolean;
    name?: string;
    tool_use_id?: unknown;
    type?: string;
  };
  if (typed.type === "tool_use" && typed.name === SEND_TOOL) {
    evidence.sawSendTool = true;
    if (typed.input?.to !== expectedTo) {
      // Addressed elsewhere: whatever it returns is not a wake for us.
      evidence.failure = `addressed to ${bounded(String(typed.input?.to))}, expected ${bounded(expectedTo)}`;
      return undefined;
    }
    return { id: String(typed.id ?? ""), to: typed.input?.to };
  }
  if (typed.type !== "tool_result" || !pending) {
    return pending;
  }
  if (String(typed.tool_use_id ?? "") !== pending.id) {
    // Some other tool's result. It says nothing about our send.
    return pending;
  }
  if (typed.is_error === true) {
    evidence.failure = "the send tool reported an error";
    return undefined;
  }
  readResultContent(typed.content, evidence);
  return undefined;
};

/**
 * Reads the send tool's own result payload. Success requires BOTH the tool's
 * success flag and the id it minted for the delivered message: a bare flag
 * with no id is not a receipt.
 */
const readResultContent = (content: unknown, evidence: SendEvidence): void => {
  for (const part of Array.isArray(content) ? content : []) {
    const text = (part as { text?: unknown })?.text;
    if (typeof text !== "string") {
      continue;
    }
    if (readResultText(text, evidence)) {
      return;
    }
  }
};

const readResultText = (text: string, evidence: SendEvidence): boolean => {
  try {
    const payload = JSON.parse(text) as {
      error?: unknown;
      msg_id?: unknown;
      success?: unknown;
    };
    if (payload.success === true && typeof payload.msg_id === "string") {
      evidence.msgId = payload.msg_id;
      evidence.success = true;
      return true;
    }
    evidence.failure = bounded(
      typeof payload.error === "string" ? payload.error : text
    );
  } catch {
    evidence.failure = bounded(text);
  }
  return false;
};

export class HeadlessClaudeWakePort implements WakePort {
  readonly #claudeBin: string;
  readonly #log: (line: string) => void;
  readonly #probe:
    | ((sessionName: string) => Promise<"busy" | "idle" | "unknown">)
    | undefined;
  readonly #run: HeadlessClaudeWakePortOptions["run"];
  readonly #timeoutMs: number;

  constructor(options: HeadlessClaudeWakePortOptions) {
    this.#claudeBin = options.claudeBin ?? "claude";
    this.#log = options.log ?? (() => undefined);
    this.#probe = options.probe;
    this.#run = options.run;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
  }

  async wake(request: WakeRequest): Promise<WakeOutcome> {
    if (this.#probe) {
      const state = await this.#probe(request.sessionName);
      if (state === "busy") {
        return "busy";
      }
    }
    const notice = wakeNoticeFor(request);
    const result = await this.#run({
      // A vector, never a shell string: the notice cannot be read as syntax.
      argv: [
        this.#claudeBin,
        "-p",
        // Labelled sections rather than quoted values: nothing in the notice
        // has to be escaped, so a path or key containing quotes cannot end the
        // field early or be corrupted to prevent it.
        [
          `Use the ${SEND_TOOL} tool exactly once.`,
          "Set summary to: mailbox wake",
          `Set to exactly this session name, on its own line below:\nTO: ${request.sessionName}`,
          `Set message to exactly the text after MESSAGE:, up to the end.\nMESSAGE:\n${notice}`,
        ].join("\n"),
        // ToolSearch is required because the send tool may be deferred: without
        // it the session cannot load the tool and sends nothing.
        "--allowedTools",
        `${SEND_TOOL} ToolSearch`,
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      timeoutMs: this.#timeoutMs,
    });
    return this.#judge(request, result);
  }

  #judge(request: WakeRequest, result: HeadlessRunResult): WakeOutcome {
    const where = `wake for ${request.recipient}`;
    if (result.cleanupFailed) {
      this.#log(`[loop] ${where} could not stop its process group`);
    }
    if (result.timedOut) {
      this.#log(`[loop] ${where} timed out after ${this.#timeoutMs}ms`);
      return "failed";
    }
    const evidence = readSendEvidence(result.stdout, request.sessionName);
    if (evidence.success) {
      // Delivered to the session, which is not the same as read or acked.
      this.#log(`[loop] ${where} queued as ${evidence.msgId}`);
      return "woken";
    }
    if (!evidence.sawSendTool) {
      this.#log(
        `[loop] ${where} ran without calling ${SEND_TOOL} (exit ${result.code})`
      );
      return "failed";
    }
    // Only the parsed failure reason is logged, never raw process output.
    this.#log(
      `[loop] ${where} did not deliver: ${evidence.failure ?? "no delivery receipt"}`
    );
    return "failed";
  }
}
