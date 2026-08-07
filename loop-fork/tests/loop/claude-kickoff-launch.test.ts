import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  const deps = {
    capturePane: () => options.paneText ?? "",
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

  test("refuses recovery when the launcher never captured its own paste", async () => {
    const harness = makeHarness({
      hooksByRead: [RUN_147_HOOKS],
      paneText: STRANDED_PANE,
    });
    await expect(
      tmuxInternals.confirmClaudeKickoff(harness.deps, RUN_DIR, {
        baseline: baselineFrom(RUN_147_HOOKS),
        expectedComposerBody: undefined,
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

  test("a proven-healthy version fails closed instead of sending a recovery key", async () => {
    const harness = makeHarness({
      cliVersion: "2.1.220 (Claude Code)",
      hooksByRead: [RUN_147_HOOKS],
      paneText: STRANDED_PANE,
    });
    await expect(
      tmuxInternals.confirmClaudeKickoff(harness.deps, RUN_DIR, {
        baseline: baselineFrom(RUN_147_HOOKS),
        expectedComposerBody: CAPTURED_KICKOFF_BODY,
        pane: PANE,
      })
    ).rejects.toThrow(tmuxInternals.ClaudeKickoffUnconfirmedError);
    expect(harness.sentKeys).toEqual([]);
    expect(harness.slept.length).toBe(
      tmuxInternals.CLAUDE_KICKOFF_CONFIRM_MAX_POLLS
    );
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
});

describe("launcher composer ownership capture", () => {
  test("captures the launcher's own paste as the expected composer body", () => {
    expect(
      tmuxInternals.captureLauncherComposerBody(
        { capturePane: () => STRANDED_PANE },
        PANE
      )
    ).toBe(CAPTURED_KICKOFF_BODY);
  });

  test("records no owner when the paste never landed", () => {
    expect(
      tmuxInternals.captureLauncherComposerBody(
        { capturePane: () => "❯ " },
        PANE
      )
    ).toBeUndefined();
  });

  test("records no owner when the pane cannot be captured", () => {
    expect(
      tmuxInternals.captureLauncherComposerBody(
        {
          capturePane: () => {
            throw new Error("pane gone");
          },
        },
        PANE
      )
    ).toBeUndefined();
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
