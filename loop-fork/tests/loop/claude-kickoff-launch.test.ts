import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeKickoffVisibilityError } from "../../src/loop/claude-kickoff";
import { tmuxInternals } from "../../src/loop/tmux";

// Launcher-level regressions for the harvto run-147 defect. Every case is
// driven from the checked-in producer fixture, and `sleep` is stubbed so the
// bounded confirmation windows are exercised without any wall-clock wait.
const FIXTURE_DIR = join(
  import.meta.dir,
  "../fixtures/claude-code/2.1.223/kickoff-channel-race"
);
const fixture = (name: string): string =>
  readFileSync(join(FIXTURE_DIR, name), "utf8");

const RUN_147_HOOKS = fixture("run-147-hooks-claude.jsonl");
const RUN_148_HOOKS = fixture("run-148-hooks-claude.jsonl");
const STRANDED_PANE = fixture("02-stranded-kickoff-composer.txt");
const HUMAN_DRAFT_PANE = fixture("03-kickoff-plus-human-draft.txt");
const CAPTURED_KICKOFF_BODY = "[Pasted text #1 +6 lines]";

const PANE = "%0";
const RUN_DIR = "/run/147";

const paneSnapshot = (input: {
  activeClients?: number;
  pipeOpen?: boolean;
  text: string;
}) => ({
  activeClients: input.activeClients ?? 0,
  cursor: { x: 2, y: 46 },
  pipeOpen: input.pipeOpen ?? false,
  text: input.text,
  windowActivity: 1,
});

interface Harness {
  deps: Parameters<typeof tmuxInternals.confirmClaudeKickoff>[0];
  logs: string[];
  sentKeys: { keys: string[]; pane: string }[];
  slept: number[];
}

const makeHarness = (options: {
  cliVersion?: string;
  hooksByRead: string[];
  paneText?: string;
  // Successive pane captures. Lets a test model the composer changing under the
  // launcher between one read and the next; the last entry repeats.
  paneTextByCapture?: string[];
  // Hook stream swapped in the moment a recovery Enter is sent, modelling the
  // stranded composer finally submitting.
  hooksAfterRecovery?: string;
  transcriptVersion?: string;
}): Harness => {
  const logs: string[] = [];
  const sentKeys: { keys: string[]; pane: string }[] = [];
  const slept: number[] = [];
  let read = 0;
  let recovered = false;
  let captures = 0;
  const deps = {
    capturePaneSnapshot: () => {
      const scripted = options.paneTextByCapture;
      if (scripted && scripted.length > 0) {
        const value = scripted[Math.min(captures, scripted.length - 1)] ?? "";
        captures += 1;
        return paneSnapshot({ text: value });
      }
      captures += 1;
      return paneSnapshot({ text: options.paneText ?? "" });
    },
    claudeCliVersion: () => options.cliVersion ?? "2.1.223 (Claude Code)",
    log: (line: string) => {
      logs.push(line);
    },
    readClaudeTranscriptVersion: () => options.transcriptVersion ?? "",
    readTextFile: () => {
      if (recovered && options.hooksAfterRecovery !== undefined) {
        return options.hooksAfterRecovery;
      }
      const value =
        options.hooksByRead[Math.min(read, options.hooksByRead.length - 1)] ??
        "";
      read += 1;
      return value;
    },
    sendKeys: (pane: string, keys: string[]) => {
      sentKeys.push({ keys, pane });
      recovered = true;
    },
    sleep: (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
  return { deps, logs, sentKeys, slept };
};

const baselineFrom = (
  hooks: string
): Parameters<typeof tmuxInternals.confirmClaudeKickoff>[2]["baseline"] =>
  tmuxInternals.readClaudeKickoffEvidence(
    {
      readClaudeTranscriptVersion: () => "",
      readTextFile: () => hooks,
    },
    RUN_DIR
  );

describe("launcher kickoff confirmation", () => {
  test("confirms a normal kickoff from hook progression", async () => {
    const harness = makeHarness({
      hooksByRead: [RUN_148_HOOKS],
    });
    await tmuxInternals.confirmClaudeKickoff(harness.deps, RUN_DIR, {
      baseline: baselineFrom(RUN_147_HOOKS),
      expectedComposerBody: CAPTURED_KICKOFF_BODY,
      pane: PANE,
    });
    // No recovery key on the happy path, and it settled on the first poll.
    expect(harness.sentKeys).toEqual([]);
    expect(harness.slept.length).toBe(1);
  });

  test("recovers a v2.1.223 channel-race stranded kickoff with one direct Enter", async () => {
    const harness = makeHarness({
      hooksAfterRecovery: RUN_148_HOOKS,
      hooksByRead: [RUN_147_HOOKS],
      paneText: STRANDED_PANE,
    });
    await tmuxInternals.confirmClaudeKickoff(harness.deps, RUN_DIR, {
      baseline: baselineFrom(RUN_147_HOOKS),
      expectedComposerBody: CAPTURED_KICKOFF_BODY,
      pane: PANE,
    });
    expect(harness.sentKeys).toEqual([{ keys: ["Enter"], pane: PANE }]);
    expect(harness.logs.join("\n")).toContain("re-sending Enter once");
  });

  test("refuses to mutate a composer holding an unrelated human draft", async () => {
    const harness = makeHarness({
      hooksByRead: [RUN_147_HOOKS],
      paneText: HUMAN_DRAFT_PANE,
    });
    await expect(
      tmuxInternals.confirmClaudeKickoff(harness.deps, RUN_DIR, {
        baseline: baselineFrom(RUN_147_HOOKS),
        expectedComposerBody: CAPTURED_KICKOFF_BODY,
        pane: PANE,
      })
    ).rejects.toThrow(tmuxInternals.ClaudeKickoffUnconfirmedError);
    expect(harness.sentKeys).toEqual([]);
  });

  test("never submits the kickoff twice once evidence shows the turn started", async () => {
    // The turn starts during the confirmation window, so the stranded-looking
    // composer must not earn a second Enter.
    const harness = makeHarness({
      hooksByRead: [RUN_147_HOOKS, RUN_148_HOOKS],
      paneText: STRANDED_PANE,
    });
    await tmuxInternals.confirmClaudeKickoff(harness.deps, RUN_DIR, {
      baseline: baselineFrom(RUN_147_HOOKS),
      expectedComposerBody: CAPTURED_KICKOFF_BODY,
      pane: PANE,
    });
    expect(harness.sentKeys).toEqual([]);
  });

  test("fails closed when no hook or transcript evidence ever arrives", async () => {
    const harness = makeHarness({
      hooksByRead: [RUN_147_HOOKS],
      paneText: STRANDED_PANE,
    });
    let thrown: unknown;
    try {
      await tmuxInternals.confirmClaudeKickoff(harness.deps, RUN_DIR, {
        baseline: baselineFrom(RUN_147_HOOKS),
        expectedComposerBody: CAPTURED_KICKOFF_BODY,
        pane: PANE,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(tmuxInternals.ClaudeKickoffUnconfirmedError);
    // Exactly one recovery attempt, never a second.
    expect(harness.sentKeys).toEqual([{ keys: ["Enter"], pane: PANE }]);
    const message = (thrown as Error).message;
    expect(message).toContain("2.1.223 (Claude Code)");
    expect(message).toContain("recovery attempted");
    // Both bounded windows were spent, and neither ran unbounded.
    expect(harness.slept.length).toBe(
      tmuxInternals.CLAUDE_KICKOFF_CONFIRM_MAX_POLLS +
        tmuxInternals.CLAUDE_KICKOFF_RECOVERY_MAX_POLLS
    );
  });

  test("no version ships as proven-healthy, so 2.1.220 is guarded too", () => {
    // The 2.1.220 fixture in this repo records captureSafety.promptSubmitted
    // false and promptSubmission false on every action: it proves startup-modal
    // handling, not a healthy kickoff. Exempting it would have disabled the
    // recovery guard for a build on evidence that does not exist.
    expect(tmuxInternals.CLAUDE_KICKOFF_PROVEN_HEALTHY_VERSIONS).toEqual([]);
  });

  test("2.1.220 still gets the guarded profile because nothing proves it healthy", async () => {
    const harness = makeHarness({
      cliVersion: "2.1.220 (Claude Code)",
      hooksAfterRecovery: RUN_148_HOOKS,
      hooksByRead: [RUN_147_HOOKS],
      paneText: STRANDED_PANE,
    });
    await tmuxInternals.confirmClaudeKickoff(harness.deps, RUN_DIR, {
      baseline: baselineFrom(RUN_147_HOOKS),
      expectedComposerBody: CAPTURED_KICKOFF_BODY,
      pane: PANE,
    });
    expect(harness.sentKeys).toEqual([{ keys: ["Enter"], pane: PANE }]);
  });

  test("refuses the recovery Enter when the composer turns foreign between reads", async () => {
    // Regression for the stale-composer race Codex found on 155a8186: the
    // composer classification and the evidence read must come from the SAME
    // snapshot. Every capture up to the final one is the launcher-owned
    // kickoff; the last one is a human draft. Hooks never advance, so a stale
    // "kickoff-owned" plus a fresh "not started" would previously send Enter
    // into somebody else's text.
    // The confirm loop performs exactly CLAUDE_KICKOFF_CONFIRM_MAX_POLLS
    // captures, so the next one is the single pre-mutation recovery read.
    const owned = new Array(
      tmuxInternals.CLAUDE_KICKOFF_CONFIRM_MAX_POLLS
    ).fill(STRANDED_PANE);
    const harness = makeHarness({
      hooksByRead: [RUN_147_HOOKS],
      paneTextByCapture: [...owned, HUMAN_DRAFT_PANE],
    });
    await expect(
      tmuxInternals.confirmClaudeKickoff(harness.deps, RUN_DIR, {
        baseline: baselineFrom(RUN_147_HOOKS),
        expectedComposerBody: CAPTURED_KICKOFF_BODY,
        pane: PANE,
      })
    ).rejects.toThrow(tmuxInternals.ClaudeKickoffUnconfirmedError);
    expect(harness.sentKeys).toEqual([]);
  });

  test("refuses the recovery Enter when the composer empties between reads", async () => {
    // Same race, other direction: the composer clears with no turn evidence.
    // Pressing Enter into an empty composer would submit nothing and could
    // re-trigger whatever the pane shows next.
    // The confirm loop performs exactly CLAUDE_KICKOFF_CONFIRM_MAX_POLLS
    // captures, so the next one is the single pre-mutation recovery read.
    const owned = new Array(
      tmuxInternals.CLAUDE_KICKOFF_CONFIRM_MAX_POLLS
    ).fill(STRANDED_PANE);
    const harness = makeHarness({
      hooksByRead: [RUN_147_HOOKS],
      paneTextByCapture: [...owned, "❯ "],
    });
    await expect(
      tmuxInternals.confirmClaudeKickoff(harness.deps, RUN_DIR, {
        baseline: baselineFrom(RUN_147_HOOKS),
        expectedComposerBody: CAPTURED_KICKOFF_BODY,
        pane: PANE,
      })
    ).rejects.toThrow(tmuxInternals.ClaudeKickoffUnconfirmedError);
    expect(harness.sentKeys).toEqual([]);
  });

  test("a moved Claude transcript version does not confirm while the kickoff still sits in the composer", async () => {
    // Claude's project transcript is versioned by size:mtimeMs, which also moves
    // when session metadata grows after SessionStart. With the launcher's own
    // kickoff still in the composer, that movement proves nothing.
    const harness = makeHarness({
      hooksByRead: [RUN_147_HOOKS],
      paneText: STRANDED_PANE,
      transcriptVersion: "moved-after-session-start",
    });
    await expect(
      tmuxInternals.confirmClaudeKickoff(harness.deps, RUN_DIR, {
        baseline: { ...baselineFrom(RUN_147_HOOKS), transcriptVersion: "v1" },
        expectedComposerBody: CAPTURED_KICKOFF_BODY,
        pane: PANE,
      })
    ).rejects.toThrow(tmuxInternals.ClaudeKickoffUnconfirmedError);
    // It did try the one permitted recovery, and still refused to call it done.
    expect(harness.sentKeys).toEqual([{ keys: ["Enter"], pane: PANE }]);
  });

  test("a moved Claude transcript version confirms once the composer is cleared", async () => {
    const harness = makeHarness({
      hooksByRead: [RUN_147_HOOKS],
      paneText: fixture("01-ready-with-channel-error.txt"),
      transcriptVersion: "moved-after-submit",
    });
    await tmuxInternals.confirmClaudeKickoff(harness.deps, RUN_DIR, {
      baseline: { ...baselineFrom(RUN_147_HOOKS), transcriptVersion: "v1" },
      expectedComposerBody: CAPTURED_KICKOFF_BODY,
      pane: PANE,
    });
    expect(harness.sentKeys).toEqual([]);
  });

  test("an unobservable claude version stays in the guarded profile", async () => {
    const harness = makeHarness({
      cliVersion: "",
      hooksAfterRecovery: RUN_148_HOOKS,
      hooksByRead: [RUN_147_HOOKS],
      paneText: STRANDED_PANE,
    });
    await tmuxInternals.confirmClaudeKickoff(harness.deps, RUN_DIR, {
      baseline: baselineFrom(RUN_147_HOOKS),
      expectedComposerBody: CAPTURED_KICKOFF_BODY,
      pane: PANE,
    });
    expect(harness.sentKeys).toEqual([{ keys: ["Enter"], pane: PANE }]);
  });

  test.each([
    ["attached", { activeClients: 1 }],
    ["piped", { pipeOpen: true }],
  ] as const)("refuses optional recovery after a post-initial %s transition", async (_label, transition) => {
    let captures = 0;
    const recoveryKeys: string[][] = [];
    const error = await tmuxInternals
      .confirmClaudeKickoff(
        {
          capturePaneSnapshot: () => {
            captures += 1;
            return paneSnapshot({
              text: `❯ ${CAPTURED_KICKOFF_BODY}`,
              ...(captures > tmuxInternals.CLAUDE_KICKOFF_CONFIRM_MAX_POLLS
                ? transition
                : {}),
            });
          },
          claudeCliVersion: () => "2.1.247 (Claude Code)",
          log: () => undefined,
          readClaudeTranscriptVersion: () => "",
          readTextFile: () => "",
          sendKeys: (_pane, keys) => {
            recoveryKeys.push(keys);
          },
          sleep: async () => undefined,
        },
        RUN_DIR,
        {
          baseline: {
            hookSequence: 0,
            sawUserPromptSubmit: false,
            transcriptVersion: "",
          },
          expectedComposerBody: CAPTURED_KICKOFF_BODY,
          pane: PANE,
        }
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(tmuxInternals.ClaudeKickoffUnconfirmedError);
    expect((error as Error).message).toContain(
      "direct-submit recovery refused"
    );
    expect(captures).toBe(tmuxInternals.CLAUDE_KICKOFF_CONFIRM_MAX_POLLS + 1);
    expect(recoveryKeys).toEqual([]);
  });
});

describe("launcher composer visibility and submission", () => {
  test("delays Enter until the exact owned paste is visible", async () => {
    const submitted: string[] = [];
    const submitCountsAtCapture: number[] = [];
    const captures = [
      paneSnapshot({ text: "❯ " }),
      paneSnapshot({ text: `❯ ${CAPTURED_KICKOFF_BODY}` }),
    ];
    const sleeps: number[] = [];
    const body = await tmuxInternals.submitVisibleClaudeKickoff({
      deps: {
        capturePaneSnapshot: () => {
          submitCountsAtCapture.push(submitted.length);
          return captures.shift();
        },
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
      emptyBeforePaste: true,
      pane: PANE,
      submit: () => {
        submitted.push("Enter");
      },
    });
    expect(body).toBe(CAPTURED_KICKOFF_BODY);
    expect(submitCountsAtCapture).toEqual([0, 0]);
    expect(sleeps).toEqual([50]);
    expect(submitted).toEqual(["Enter"]);
  });

  test("submits exactly once when visibility is immediate", async () => {
    const submitted: string[] = [];
    await tmuxInternals.submitVisibleClaudeKickoff({
      deps: {
        capturePaneSnapshot: () =>
          paneSnapshot({ text: `❯ ${CAPTURED_KICKOFF_BODY}` }),
        sleep: async () => undefined,
      },
      emptyBeforePaste: true,
      pane: PANE,
      submit: () => {
        submitted.push("Enter");
      },
    });
    expect(submitted).toEqual(["Enter"]);
  });

  test("submits zero Enter on unsafe or timed-out visibility", async () => {
    const cases = [
      { failure: "timeout", snapshot: () => paneSnapshot({ text: "❯ " }) },
      { failure: "indeterminate", snapshot: () => undefined },
      {
        failure: "foreign",
        snapshot: () => paneSnapshot({ text: "❯ human draft" }),
      },
      {
        failure: "attached",
        snapshot: () =>
          paneSnapshot({
            activeClients: 1,
            text: `❯ ${CAPTURED_KICKOFF_BODY}`,
          }),
      },
      {
        failure: "piped",
        snapshot: () =>
          paneSnapshot({ pipeOpen: true, text: `❯ ${CAPTURED_KICKOFF_BODY}` }),
      },
    ] as const;
    for (const current of cases) {
      const submitted: string[] = [];
      const error = await tmuxInternals
        .submitVisibleClaudeKickoff({
          deps: {
            capturePaneSnapshot: current.snapshot,
            sleep: async () => undefined,
          },
          emptyBeforePaste: true,
          pane: PANE,
          submit: () => {
            submitted.push("Enter");
          },
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ClaudeKickoffVisibilityError);
      expect((error as ClaudeKickoffVisibilityError).failure).toBe(
        current.failure
      );
      expect(submitted).toEqual([]);
    }
  });

  test("requires positive empty-before-paste proof", async () => {
    const submitted: string[] = [];
    const error = await tmuxInternals
      .submitVisibleClaudeKickoff({
        deps: {
          capturePaneSnapshot: () =>
            paneSnapshot({ text: `❯ ${CAPTURED_KICKOFF_BODY}` }),
          sleep: async () => undefined,
        },
        emptyBeforePaste: false,
        pane: PANE,
        submit: () => {
          submitted.push("Enter");
        },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClaudeKickoffVisibilityError);
    expect((error as ClaudeKickoffVisibilityError).failure).toBe(
      "not-empty-before-paste"
    );
    expect(submitted).toEqual([]);
  });
});

describe("kickoff evidence source", () => {
  test("reads Claude's hook journal, never the run-local transcript.jsonl", () => {
    const requested: string[] = [];
    const evidence = tmuxInternals.readClaudeKickoffEvidence(
      {
        readClaudeTranscriptVersion: () => "claude-transcript-v1",
        readTextFile: (path: string) => {
          requested.push(path);
          return RUN_148_HOOKS;
        },
      },
      RUN_DIR
    );
    expect(requested).toEqual([join(RUN_DIR, "hooks", "claude.jsonl")]);
    // The run-local transcript is written by Codex, OSS, and bridge activity,
    // so it must never appear as a kickoff evidence source.
    expect(requested.join("|")).not.toContain(
      join(RUN_DIR, "transcript.jsonl")
    );
    expect(evidence.sawUserPromptSubmit).toBe(true);
    expect(evidence.transcriptVersion).toBe("claude-transcript-v1");
  });
});
