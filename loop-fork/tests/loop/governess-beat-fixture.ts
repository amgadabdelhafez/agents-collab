// The gov-6 beat fixture: one ordered script of governess beats, replayed three
// ways — through the pre-refactor JSONL writer (golden), through the current
// JSONL writer, and through the governess-beat.v1 Temporal workflow. Because all
// three consume this same script, "the exported journal equals the old JSONL
// journal" is a comparison of three independent producers, not of one with
// itself.
//
// Every beat carries an explicit `at`, and control ids come from a deterministic
// counter, so nothing here depends on a clock or a random source.

export type GovernessFixtureBeat =
  | {
      action: string;
      agent?: string;
      at: string;
      epoch: number;
      idempotencyKey: string;
      kind: "prepare";
      payload: string;
      policyClass: string;
    }
  | {
      agent?: string;
      at: string;
      epoch: number;
      heartbeatMs?: number;
      idempotencyKey: string;
      kind: "observe";
      payload: string;
      policyClass: string;
      semanticPayload?: string;
      stream: string;
    }
  | {
      at: string;
      controlRef: string;
      evidence?: string;
      kind: "transition";
      phase: string;
      reason?: string;
      transport?: string;
    };

/**
 * The prompt body. It is fed to effectful beats deliberately so proof check 3
 * has something real to hunt for: if any history event or signal payload ever
 * carries this string, the audit contract has been broken.
 */
export const GOVERNESS_FIXTURE_PROMPT_BODY =
  "SENSITIVE-PROMPT-BODY do not restart the agent until the merge lands";

export const GOVERNESS_FIXTURE: GovernessFixtureBeat[] = [
  // A plain observation opens the stream.
  {
    agent: "claude",
    at: "2026-09-01T00:00:00.000Z",
    epoch: 1,
    idempotencyKey: "obs:claude:1",
    kind: "observe",
    payload: "pane idle, no diff",
    policyClass: "observe",
    stream: "pane:claude",
  },
  // Same semantic content inside the heartbeat window: must dedupe, not append.
  {
    agent: "claude",
    at: "2026-09-01T00:00:10.000Z",
    epoch: 1,
    idempotencyKey: "obs:claude:2",
    kind: "observe",
    payload: "pane idle, no diff",
    policyClass: "observe",
    stream: "pane:claude",
  },
  // Changed content: must append.
  {
    agent: "claude",
    at: "2026-09-01T00:00:20.000Z",
    epoch: 1,
    idempotencyKey: "obs:claude:3",
    kind: "observe",
    payload: "pane running tests",
    policyClass: "observe",
    stream: "pane:claude",
  },
  // An effectful control carrying a prompt body: only its hash may be recorded.
  {
    action: "nudge",
    agent: "claude",
    at: "2026-09-01T00:01:00.000Z",
    epoch: 1,
    idempotencyKey: "nudge:claude:1",
    kind: "prepare",
    payload: GOVERNESS_FIXTURE_PROMPT_BODY,
    policyClass: "safe-automatic",
  },
  {
    at: "2026-09-01T00:01:01.000Z",
    controlRef: "nudge:claude:1",
    kind: "transition",
    phase: "dispatched",
    transport: "claude-channel",
  },
  {
    at: "2026-09-01T00:01:02.000Z",
    controlRef: "nudge:claude:1",
    evidence: "channel ack",
    kind: "transition",
    phase: "accepted",
  },
  {
    at: "2026-09-01T00:01:03.000Z",
    controlRef: "nudge:claude:1",
    kind: "transition",
    phase: "completed",
  },
  // Re-raising the same idempotency key after completion must reuse, not append.
  {
    action: "nudge",
    agent: "claude",
    at: "2026-09-01T00:02:00.000Z",
    epoch: 1,
    idempotencyKey: "nudge:claude:1",
    kind: "prepare",
    payload: GOVERNESS_FIXTURE_PROMPT_BODY,
    policyClass: "safe-automatic",
  },
  // A control that fails before dispatch stays retryable under a new control id.
  {
    action: "restart-agent",
    agent: "codex",
    at: "2026-09-01T00:03:00.000Z",
    epoch: 2,
    idempotencyKey: "restart:codex:1",
    kind: "prepare",
    payload: "restart codex seat",
    policyClass: "require-confirmation",
  },
  {
    at: "2026-09-01T00:03:01.000Z",
    controlRef: "restart:codex:1",
    kind: "transition",
    phase: "failed",
    reason: "transport unavailable",
  },
  {
    action: "restart-agent",
    agent: "codex",
    at: "2026-09-01T00:03:02.000Z",
    epoch: 2,
    idempotencyKey: "restart:codex:1",
    kind: "prepare",
    payload: "restart codex seat",
    policyClass: "require-confirmation",
  },
  {
    at: "2026-09-01T00:03:03.000Z",
    controlRef: "restart:codex:1",
    kind: "transition",
    phase: "dispatched",
    transport: "codex-app-server",
  },
  {
    at: "2026-09-01T00:03:04.000Z",
    controlRef: "restart:codex:1",
    kind: "transition",
    phase: "completed",
  },
];

interface JournalWriterModule {
  prepareGovernessControl: (
    journalFile: string,
    input: Record<string, unknown>
  ) => { controlId: string };
  recordGovernessObservation: (
    journalFile: string,
    input: Record<string, unknown>
  ) => { record: { controlId: string } };
  transitionGovernessControl: (
    journalFile: string,
    controlId: string,
    phase: string,
    at: string,
    reason?: string,
    details?: Record<string, unknown>
  ) => unknown;
}

const prepareInput = (
  beat: Extract<GovernessFixtureBeat, { kind: "prepare" }>
): Record<string, unknown> => ({
  action: beat.action,
  ...(beat.agent ? { agent: beat.agent } : {}),
  at: beat.at,
  epoch: beat.epoch,
  idempotencyKey: beat.idempotencyKey,
  payload: beat.payload,
  policyClass: beat.policyClass,
});

const observeInput = (
  beat: Extract<GovernessFixtureBeat, { kind: "observe" }>
): Record<string, unknown> => ({
  ...(beat.agent ? { agent: beat.agent } : {}),
  at: beat.at,
  epoch: beat.epoch,
  ...(beat.heartbeatMs === undefined ? {} : { heartbeatMs: beat.heartbeatMs }),
  idempotencyKey: beat.idempotencyKey,
  payload: beat.payload,
  policyClass: beat.policyClass,
  ...(beat.semanticPayload === undefined
    ? {}
    : { semanticPayload: beat.semanticPayload }),
  stream: beat.stream,
});

const transitionDetails = (
  beat: Extract<GovernessFixtureBeat, { kind: "transition" }>
): Record<string, unknown> => ({
  ...(beat.evidence ? { evidence: beat.evidence } : {}),
  ...(beat.transport ? { transport: beat.transport } : {}),
});

/**
 * Drive a JSONL writer module through the fixture. Takes the module rather than
 * importing one so the same script can run against the pre-refactor writer.
 */
export const applyGovernessFixture = (
  writer: JournalWriterModule,
  journalFile: string,
  beats: readonly GovernessFixtureBeat[]
): void => {
  const controlIds = new Map<string, string>();
  for (const beat of beats) {
    if (beat.kind === "prepare") {
      const record = writer.prepareGovernessControl(
        journalFile,
        prepareInput(beat)
      );
      controlIds.set(beat.idempotencyKey, record.controlId);
      continue;
    }
    if (beat.kind === "observe") {
      writer.recordGovernessObservation(journalFile, observeInput(beat));
      continue;
    }
    const controlId = controlIds.get(beat.controlRef);
    if (!controlId) {
      throw new Error(`fixture references unknown control ${beat.controlRef}`);
    }
    writer.transitionGovernessControl(
      journalFile,
      controlId,
      beat.phase,
      beat.at,
      beat.reason,
      transitionDetails(beat)
    );
  }
};
