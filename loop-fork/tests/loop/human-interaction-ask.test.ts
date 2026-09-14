import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasCurrentPublicAskEpisode,
  MAX_PUBLIC_ASK_JOURNAL_BYTES,
  MAX_PUBLIC_ASK_RECORD_BYTES,
  MAX_PUBLIC_ASK_RECORDS,
  PUBLIC_ASK_JOURNAL_NAME,
  parsePublicAskRecords,
  publicAskAnswerResponseId,
  publicAskDecisionResponseId,
  publicAskId,
  publishPublicAsk,
  readPublicAskRecords,
  resolvePublicAskAnswer,
  resolvePublicAskDecision,
} from "../../src/loop/human-interaction-ask";

const NOW = "2026-08-28T12:00:00.000Z";

const makeRun = (): { root: string; runDir: string } => {
  const root = mkdtempSync(join(tmpdir(), "public-human-ask-"));
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({
      createdAt: "2026-08-28T11:00:00.000Z",
      cwd: "/redacted/worktree",
      mode: "paired",
      pid: 42,
      repoId: "repo-a",
      runId: "7",
      state: "input-required",
      status: "running",
      updatedAt: "2026-08-28T11:59:59.000Z",
    })
  );
  writeFileSync(
    join(runDir, "governess-state.json"),
    JSON.stringify({
      lifecycleEvents: {
        claude: {
          agent: "claude",
          at: "2026-08-28T11:59:58.000Z",
          epoch: 3,
          sequence: 12,
          source: "agent-hook",
          sourceSequence: 41,
          state: "input-required",
        },
      },
    })
  );
  return { root, runDir };
};

const approval = () => ({
  consequence: "The migration may briefly pause background jobs.",
  kind: "approval" as const,
  prompt: "Approve the verified database migration?",
  title: "Migration approval",
});

const question = () => ({
  kind: "question" as const,
  prompt: "Which surface should be prioritized?",
  title: "Wearable next step",
});

const writeManifestState = (
  runDir: string,
  state: "completed" | "input-required" | "stopped",
  status: "done" | "running" | "stopped"
): void => {
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({
      createdAt: "2026-08-28T11:00:00.000Z",
      cwd: "/redacted/worktree",
      mode: "paired",
      pid: 42,
      repoId: "repo-a",
      runId: "7",
      state,
      status,
      updatedAt: "2026-08-28T11:59:59.000Z",
    })
  );
};

describe("producer-attested public ask journal", () => {
  test("resolves one short answer by correlation without publishing its text", () => {
    const { root, runDir } = makeRun();
    try {
      const ask = publishPublicAsk(runDir, "claude", question(), {
        now: () => NOW,
      });
      const answer = "Prioritize phone actions";
      const resolved = resolvePublicAskAnswer(runDir, {
        askId: ask.id,
        binding: ask.binding,
        resolvedAt: "2026-08-28T12:00:01.000Z",
        value: answer,
      });
      expect(resolved).toMatchObject({
        responseCorrelation: {
          responseId: publicAskAnswerResponseId(ask.id, answer),
        },
        state: "resolved",
      });
      expect(JSON.stringify(readPublicAskRecords(runDir))).not.toContain(
        answer
      );
      expect(
        resolvePublicAskAnswer(runDir, {
          askId: ask.id,
          binding: ask.binding,
          resolvedAt: "2026-08-28T12:00:02.000Z",
          value: answer,
        })
      ).toEqual(resolved);
      expect(() =>
        resolvePublicAskAnswer(runDir, {
          askId: ask.id,
          binding: ask.binding,
          resolvedAt: "2026-08-28T12:00:02.000Z",
          value: "Prioritize the watch",
        })
      ).toThrow("conflicts");
      for (const value of ["", " leading", "trailing ", "line\nbreak"]) {
        expect(() =>
          resolvePublicAskAnswer(runDir, {
            askId: ask.id,
            binding: ask.binding,
            resolvedAt: "2026-08-28T12:00:02.000Z",
            value,
          })
        ).toThrow("invalid");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reserves terminal capacity and resolves one decision deterministically", () => {
    const { root, runDir } = makeRun();
    try {
      const open = publishPublicAsk(runDir, "claude", approval(), {
        now: () => NOW,
      });
      const resolvedAt = "2026-08-28T12:00:01.000Z";
      const resolved = resolvePublicAskDecision(runDir, {
        askId: open.id,
        binding: open.binding,
        intent: "approve",
        resolvedAt,
      });
      expect(resolved).toMatchObject({
        id: open.id,
        responseCorrelation: {
          resolvedAt,
          responseId: publicAskDecisionResponseId(open.id, "approve"),
        },
        state: "resolved",
        updatedAt: resolvedAt,
      });
      expect(readPublicAskRecords(runDir)).toEqual([resolved]);
      const path = join(runDir, PUBLIC_ASK_JOURNAL_NAME);
      expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
      const beforeRetry = readFileSync(path);
      expect(
        resolvePublicAskDecision(runDir, {
          askId: open.id,
          binding: open.binding,
          intent: "approve",
          resolvedAt: "2026-08-28T12:00:02.000Z",
        })
      ).toEqual(resolved);
      expect(readFileSync(path)).toEqual(beforeRetry);
      expect(() =>
        resolvePublicAskDecision(runDir, {
          askId: open.id,
          binding: open.binding,
          intent: "reject",
          resolvedAt: "2026-08-28T12:00:02.000Z",
        })
      ).toThrow("conflicts");
      expect(readFileSync(path)).toEqual(beforeRetry);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reserves worst-case terminals for every concurrently open ask", () => {
    const { root, runDir } = makeRun();
    try {
      const template = publishPublicAsk(runDir, "claude", approval(), {
        now: () => NOW,
      });
      const path = join(runDir, PUBLIC_ASK_JOURNAL_NAME);
      const other = (index: number) => {
        const binding = { ...template.binding, sequence: 1000 + index };
        return { ...template, binding, id: publicAskId(binding) };
      };
      const rowBytes = Buffer.byteLength(`${JSON.stringify(other(0))}\n`);
      const currentBytes = Buffer.byteLength(`${JSON.stringify(template)}\n`);
      const byteBound = Math.floor(
        (MAX_PUBLIC_ASK_JOURNAL_BYTES -
          currentBytes -
          MAX_PUBLIC_ASK_RECORD_BYTES) /
          (rowBytes + MAX_PUBLIC_ASK_RECORD_BYTES)
      );
      const rowBound = Math.floor((MAX_PUBLIC_ASK_RECORDS - 2) / 2);
      const safeOpenCount = Math.min(byteBound, rowBound);
      const safeRows = Array.from({ length: safeOpenCount }, (_, index) =>
        other(index)
      );
      writeFileSync(
        path,
        `${safeRows.map((row) => JSON.stringify(row)).join("\n")}\n`
      );

      const open = publishPublicAsk(runDir, "claude", approval(), {
        now: () => NOW,
      });
      const resolved = resolvePublicAskDecision(runDir, {
        askId: open.id,
        binding: open.binding,
        intent: "approve",
        resolvedAt: "2026-08-28T12:00:01.000Z",
      });
      expect(resolved.state).toBe("resolved");

      const unsafeRows = [...safeRows, other(safeOpenCount)];
      writeFileSync(
        path,
        `${unsafeRows.map((row) => JSON.stringify(row)).join("\n")}\n`
      );
      const before = readFileSync(path);
      expect(() =>
        publishPublicAsk(runDir, "claude", approval(), { now: () => NOW })
      ).toThrow(/capacity|oversized/u);
      expect(readFileSync(path)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("derives episode authority and makes an identical retry idempotent", () => {
    const { root, runDir } = makeRun();
    try {
      const first = publishPublicAsk(runDir, "claude", approval(), {
        now: () => NOW,
      });
      const second = publishPublicAsk(runDir, "claude", approval(), {
        now: () => "2026-08-28T12:00:01.000Z",
      });
      expect(second).toEqual(first);
      expect(first).toMatchObject({
        authority: "agent-response-only",
        binding: {
          agent: "claude",
          epoch: 3,
          repoId: "repo-a",
          runId: "7",
          sequence: 12,
        },
        consequence: {
          digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
          statement: approval().consequence,
        },
        createdAt: NOW,
        kind: "approval",
        response: {
          intents: ["approve", "reject"],
          mode: "approve-reject",
        },
        state: "open",
        updatedAt: NOW,
        version: "1",
      });
      expect(first.id).toMatch(/^ask_[0-9a-f]{32}$/u);
      expect(readPublicAskRecords(runDir)).toEqual([first]);
      expect(
        readFileSync(join(runDir, PUBLIC_ASK_JOURNAL_NAME), "utf8")
          .trim()
          .split("\n")
      ).toHaveLength(1);
      const serialized = JSON.stringify(first);
      for (const forbidden of [
        "routeId",
        "provider",
        "waitingAsk",
        "transcript",
        "/redacted/worktree",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("conflicting retry, stale episode, foreign source label, and malformed public text create no evidence", () => {
    const { root, runDir } = makeRun();
    try {
      const first = publishPublicAsk(runDir, "claude", approval(), {
        now: () => NOW,
      });
      expect(() =>
        publishPublicAsk(
          runDir,
          "claude",
          { ...approval(), prompt: "Approve a different operation?" },
          { now: () => NOW }
        )
      ).toThrow("conflicts");
      expect(() =>
        publishPublicAsk(runDir, "codex", approval(), { now: () => NOW })
      ).toThrow("current input-required episode");
      expect(() =>
        publishPublicAsk(
          runDir,
          "claude",
          { ...approval(), prompt: "Read /private/transcript.jsonl?" },
          { now: () => NOW }
        )
      ).toThrow("public display text");
      expect(readPublicAskRecords(runDir)).toEqual([first]);

      writeFileSync(
        join(runDir, "governess-state.json"),
        JSON.stringify({
          lifecycleEvents: {
            claude: {
              agent: "claude",
              at: NOW,
              epoch: 3,
              sequence: 13,
              state: "working",
            },
          },
        })
      );
      // Published mid-turn: bound to the idle episode that ends the turn.
      const midTurn = publishPublicAsk(runDir, "claude", approval(), {
        now: () => NOW,
      });
      expect(midTurn.binding.sequence).toBe(14);
      expect(readPublicAskRecords(runDir)).toEqual(
        expect.arrayContaining([first, midTurn])
      );
      expect(readPublicAskRecords(runDir)).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unsafe symlink and non-newline-terminated journals fail closed without writes", () => {
    const { root, runDir } = makeRun();
    const external = join(root, "external.jsonl");
    try {
      writeFileSync(external, "");
      symlinkSync(external, join(runDir, PUBLIC_ASK_JOURNAL_NAME));
      expect(() =>
        publishPublicAsk(runDir, "claude", approval(), { now: () => NOW })
      ).toThrow("unsafe");
      expect(() => readPublicAskRecords(runDir)).toThrow("unsafe");

      rmSync(join(runDir, PUBLIC_ASK_JOURNAL_NAME));
      const record = publishPublicAsk(runDir, "claude", approval(), {
        now: () => NOW,
      });
      const path = join(runDir, PUBLIC_ASK_JOURNAL_NAME);
      writeFileSync(path, JSON.stringify(record));
      const before = readFileSync(path);
      expect(() => readPublicAskRecords(runDir)).toThrow("malformed");
      expect(() =>
        publishPublicAsk(runDir, "claude", approval(), { now: () => NOW })
      ).toThrow("malformed");
      expect(readFileSync(path)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("record capacity blocks a new append but permits an exact retry", () => {
    const { root, runDir } = makeRun();
    try {
      const current = publishPublicAsk(runDir, "claude", approval(), {
        now: () => NOW,
      });
      const otherRecords = Array.from(
        { length: MAX_PUBLIC_ASK_RECORDS - 1 },
        (_, index) => {
          const binding = {
            ...current.binding,
            sequence: 1000 + index,
          };
          return { ...current, binding, id: publicAskId(binding) };
        }
      );
      const path = join(runDir, PUBLIC_ASK_JOURNAL_NAME);
      writeFileSync(
        path,
        `${[current, ...otherRecords].map((row) => JSON.stringify(row)).join("\n")}\n`
      );
      const retryBefore = readFileSync(path);
      expect(
        publishPublicAsk(runDir, "claude", approval(), { now: () => NOW })
      ).toEqual(current);
      expect(readFileSync(path)).toEqual(retryBefore);

      const fullWithoutCurrent = [...otherRecords];
      const extraBinding = { ...current.binding, sequence: 2000 };
      fullWithoutCurrent.push({
        ...current,
        binding: extraBinding,
        id: publicAskId(extraBinding),
      });
      writeFileSync(
        path,
        `${fullWithoutCurrent.map((row) => JSON.stringify(row)).join("\n")}\n`
      );
      const capacityBefore = readFileSync(path);
      expect(() =>
        publishPublicAsk(runDir, "claude", approval(), { now: () => NOW })
      ).toThrow("record capacity");
      expect(readFileSync(path)).toEqual(capacityBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("terminal manifest state rejects initial and final publication checks", () => {
    const { root, runDir } = makeRun();
    try {
      writeManifestState(runDir, "completed", "done");
      expect(hasCurrentPublicAskEpisode(runDir, "claude")).toBe(false);
      expect(() =>
        publishPublicAsk(runDir, "claude", approval(), { now: () => NOW })
      ).toThrow("current input-required episode");
      expect(readPublicAskRecords(runDir)).toEqual([]);

      writeManifestState(runDir, "input-required", "running");
      expect(() =>
        publishPublicAsk(runDir, "claude", approval(), {
          afterJournalOpen: () => {
            writeManifestState(runDir, "stopped", "stopped");
          },
          now: () => NOW,
        })
      ).toThrow("current input-required episode");
      expect(readPublicAskRecords(runDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an identical retry rechecks current lifecycle before returning", () => {
    const { root, runDir } = makeRun();
    try {
      const current = publishPublicAsk(runDir, "claude", approval(), {
        now: () => NOW,
      });
      const path = join(runDir, PUBLIC_ASK_JOURNAL_NAME);
      const before = readFileSync(path);
      expect(() =>
        publishPublicAsk(runDir, "claude", approval(), {
          afterEvidenceRead: () => {
            writeManifestState(runDir, "completed", "done");
          },
          now: () => "2026-08-28T12:00:01.000Z",
        })
      ).toThrow("current input-required episode");
      expect(readFileSync(path)).toEqual(before);
      expect(readPublicAskRecords(runDir)).toEqual([current]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("episode movement after the first read and over-bound text append nothing", () => {
    const { root, runDir } = makeRun();
    try {
      expect(() =>
        publishPublicAsk(runDir, "claude", approval(), {
          afterEvidenceRead: () => {
            writeFileSync(
              join(runDir, "governess-state.json"),
              JSON.stringify({
                lifecycleEvents: {
                  claude: {
                    agent: "claude",
                    at: NOW,
                    epoch: 3,
                    sequence: 13,
                    state: "working",
                  },
                },
              })
            );
          },
          now: () => NOW,
        })
      ).toThrow("current input-required episode");
      expect(readPublicAskRecords(runDir)).toEqual([]);

      expect(() =>
        publishPublicAsk(
          runDir,
          "claude",
          { ...approval(), title: "x".repeat(81) },
          { now: () => NOW }
        )
      ).toThrow("public display text");
      expect(readPublicAskRecords(runDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("episode movement at the journal boundary appends zero evidence", () => {
    const { root, runDir } = makeRun();
    try {
      expect(() =>
        publishPublicAsk(runDir, "claude", approval(), {
          afterJournalOpen: () => {
            writeFileSync(
              join(runDir, "governess-state.json"),
              JSON.stringify({
                lifecycleEvents: {
                  claude: {
                    agent: "claude",
                    at: NOW,
                    epoch: 3,
                    sequence: 13,
                    state: "working",
                  },
                },
              })
            );
          },
          now: () => NOW,
        })
      ).toThrow("current input-required episode");
      expect(readPublicAskRecords(runDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("run-directory replacement during the final authority read appends zero evidence", () => {
    const { root, runDir } = makeRun();
    const movedRunDir = `${runDir}-moved`;
    try {
      expect(() =>
        publishPublicAsk(runDir, "claude", approval(), {
          afterAuthorityRecheck: () => {
            renameSync(runDir, movedRunDir);
            mkdirSync(runDir);
            writeFileSync(
              join(runDir, "manifest.json"),
              readFileSync(join(movedRunDir, "manifest.json"))
            );
            writeFileSync(
              join(runDir, "governess-state.json"),
              readFileSync(join(movedRunDir, "governess-state.json"))
            );
          },
          now: () => NOW,
        })
      ).toThrow("root is unsafe");
      expect(readPublicAskRecords(movedRunDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lifecycle movement after the advisory hook leaves existing journal bytes unchanged", () => {
    const { root, runDir } = makeRun();
    try {
      publishPublicAsk(runDir, "claude", approval(), { now: () => NOW });
      writeFileSync(
        join(runDir, "governess-state.json"),
        JSON.stringify({
          lifecycleEvents: {
            claude: {
              agent: "claude",
              at: "2026-08-28T12:01:00.000Z",
              epoch: 3,
              sequence: 13,
              state: "input-required",
            },
          },
        })
      );
      const path = join(runDir, PUBLIC_ASK_JOURNAL_NAME);
      const before = readFileSync(path);
      expect(() =>
        publishPublicAsk(runDir, "claude", approval(), {
          afterAuthorityRecheck: () => {
            writeFileSync(
              join(runDir, "governess-state.json"),
              JSON.stringify({
                lifecycleEvents: {
                  claude: {
                    agent: "claude",
                    at: "2026-08-28T12:01:01.000Z",
                    epoch: 3,
                    sequence: 14,
                    state: "working",
                  },
                },
              })
            );
          },
          now: () => "2026-08-28T12:01:00.000Z",
        })
      ).toThrow("current input-required episode");
      expect(readFileSync(path)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("folds one immutable open to resolved transition and rejects divergence", () => {
    const { root, runDir } = makeRun();
    try {
      const open = publishPublicAsk(runDir, "claude", approval(), {
        now: () => NOW,
      });
      const resolved = {
        ...open,
        responseCorrelation: {
          resolvedAt: "2026-08-28T12:01:00.000Z",
          responseId: `resp_${"a".repeat(32)}`,
        },
        state: "resolved" as const,
        updatedAt: "2026-08-28T12:01:00.000Z",
      };
      expect(parsePublicAskRecords([open, resolved])).toEqual([resolved]);
      expect(() =>
        parsePublicAskRecords([
          open,
          {
            ...resolved,
            prompt: "A divergent prompt?",
          },
        ])
      ).toThrow("conflict");
      expect(() => parsePublicAskRecords([resolved, open])).toThrow("conflict");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
