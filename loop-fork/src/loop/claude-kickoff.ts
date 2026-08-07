// Guard for the harvto run-147 defect: the launcher pasted its kickoff into the
// Claude pane, sent Enter, and reported a running loop, while Claude Code
// 2.1.223 left the text unsubmitted behind a development-channel startup error.
// `tmux send-keys` success is not evidence that a turn began.
//
// Pure module: no I/O, no process access. Every seam the launcher needs is a
// parameter, so the regressions in tests/loop/claude-kickoff.test.ts replay the
// captured producer bytes directly. See
// specs/claude-kickoff-submit-guard/spec.md.

export interface ClaudeKickoffEvidence {
  hookSequence: number;
  sawUserPromptSubmit: boolean;
  // Version of Claude's own project session transcript, read through
  // `readClaudeTranscriptVersionFromProjects`. Deliberately NOT the run-local
  // `<runDir>/transcript.jsonl`, which `appendRunTranscriptEntry` grows from
  // Codex, OSS, and bridge activity and would therefore confirm a Claude turn
  // that never happened.
  transcriptVersion: string;
}

export interface ClaudeCliVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface ClaudeKickoffCapability {
  confirmRequired: boolean;
  recoveryAllowed: boolean;
}

export type ClaudeKickoffComposerState =
  | "empty"
  | "kickoff-owned"
  | "foreign"
  | "indeterminate";

// Exactly the events `hooks/emit.ts::lifecycleState` maps to `working`.
// `Notification` and `Stop` are excluded deliberately: that same function maps
// both to `input-required`, and either can fire without proving this kickoff
// began. A bare `state: "working"` field is never trusted on its own either.
const TURN_PROGRESS_EVENTS = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
]);

export const parseClaudeHookEvidence = (
  text: string | undefined
): { hookSequence: number; sawUserPromptSubmit: boolean } => {
  let hookSequence = 0;
  let sawUserPromptSubmit = false;

  if (text === undefined) {
    return { hookSequence, sawUserPromptSubmit };
  }

  // A hook line can still be mid-write when we read, so a blank or trailing
  // partial line is normal and must never throw or count.
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const event = parsed.event;
    if (typeof event !== "string" || !TURN_PROGRESS_EVENTS.has(event)) {
      continue;
    }
    const sequence = parsed.sequence;
    if (
      typeof sequence === "number" &&
      Number.isFinite(sequence) &&
      sequence > hookSequence
    ) {
      hookSequence = sequence;
    }
    if (event === "UserPromptSubmit") {
      sawUserPromptSubmit = true;
    }
  }

  return { hookSequence, sawUserPromptSubmit };
};

// Every comparison is strict and baseline-relative, so a rotated or truncated
// hook file reads as "no progress" rather than as growth.
//
// Hook evidence stands alone. The Claude project transcript does not: its
// version is `size:mtimeMs`, which also moves when session metadata grows
// asynchronously after SessionStart. It therefore only confirms in conjunction
// with a composer that no longer holds the launcher-owned kickoff, matching the
// cleared-composer convention the runtime bridge delivery path already uses.
export const kickoffTurnStarted = (
  before: ClaudeKickoffEvidence,
  after: ClaudeKickoffEvidence,
  composer: ClaudeKickoffComposerState
): boolean => {
  if (after.sawUserPromptSubmit && !before.sawUserPromptSubmit) {
    return true;
  }
  if (after.hookSequence > before.hookSequence) {
    return true;
  }
  return (
    composer === "empty" &&
    after.transcriptVersion !== "" &&
    after.transcriptVersion !== before.transcriptVersion
  );
};

const CLI_VERSION_RE = /(\d+)\.(\d+)\.(\d+)/;

export const parseClaudeCliVersion = (
  raw: string | undefined
): ClaudeCliVersion | undefined => {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const match = raw.match(CLI_VERSION_RE);
  const [, major, minor, patch] = match ?? [];
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
  };
};

// Confirmation is required on every version because it is correct everywhere.
// Only the mutating recovery keystroke is version-gated, and only by EXACT
// membership in the set of versions that carry a checked-in healthy producer
// fixture. A `<=` range is not used: one healthy 2.1.220 capture proves 2.1.220,
// not every lower version, and semver ordering is not capability evidence.
// Unknown and unparseable versions stay guarded, so this cannot go stale into a
// fail-open the way a blacklist would.
export const resolveKickoffCapability = (
  version: ClaudeCliVersion | undefined,
  provenHealthy: readonly ClaudeCliVersion[]
): ClaudeKickoffCapability => {
  if (version === undefined) {
    return { confirmRequired: true, recoveryAllowed: true };
  }
  const proven = provenHealthy.some(
    (candidate) =>
      candidate.major === version.major &&
      candidate.minor === version.minor &&
      candidate.patch === version.patch
  );
  return { confirmRequired: true, recoveryAllowed: !proven };
};

const COMPOSER_PROMPT_MARKER = "❯";

// An idle 2.1.223 composer is not blank: it renders a greyed suggestion such as
// `Try "how does <filepath> work?"` (fixture 01-ready-with-channel-error.txt,
// line 57). That is chrome, not user content. Claude Code's own cursor probe in
// `unblockClaudePane` is the authority when a pane snapshot is available; this
// classifier only decides whether a keystroke would submit somebody's text.
const COMPOSER_PLACEHOLDER_RE = /^Try ".*"$/;

export const readComposerBody = (
  paneText: string | undefined
): string | undefined => {
  if (paneText === undefined) {
    return undefined;
  }
  const lines = paneText.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = (lines[index] ?? "").trimStart();
    if (candidate.startsWith(COMPOSER_PROMPT_MARKER)) {
      return candidate.slice(COMPOSER_PROMPT_MARKER.length).trim();
    }
  }
  return undefined;
};

// Ownership is established by construction, never by pattern matching. The
// launcher verifies the composer is empty, pastes, and captures the resulting
// body before sending its first Enter; `expectedComposerBody` is that capture.
// A generic `[Pasted text #N +M lines]` marker proves nothing on its own, since
// any paste renders it. Only an exact match against the launcher's own capture
// permits the recovery keystroke, and an absent capture refuses it.
export const classifyKickoffComposer = (input: {
  paneText: string | undefined;
  expectedComposerBody: string | undefined;
}): ClaudeKickoffComposerState => {
  const body = readComposerBody(input.paneText);
  if (body === undefined) {
    return "indeterminate";
  }
  if (body === "" || COMPOSER_PLACEHOLDER_RE.test(body)) {
    return "empty";
  }
  if (input.expectedComposerBody === undefined) {
    // We never positively captured what our own paste produced, so we cannot
    // claim this text is ours. Fail closed.
    return "indeterminate";
  }
  return body === input.expectedComposerBody ? "kickoff-owned" : "foreign";
};
