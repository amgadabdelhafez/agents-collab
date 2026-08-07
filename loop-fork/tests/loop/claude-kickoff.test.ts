import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyKickoffComposer,
  kickoffTurnStarted,
  parseClaudeCliVersion,
  parseClaudeHookEvidence,
  readComposerBody,
  resolveKickoffCapability,
} from "../../src/loop/claude-kickoff";

// Producer fixture captured from real Claude Code 2.1.223 plus the preserved
// harvto run-147 / run-148 hook streams. See fixture-index.json for provenance,
// including the explicit note that the run-147 strand itself is a timing race
// that was not reproduced live.
const FIXTURE_DIR = join(
  import.meta.dir,
  "../fixtures/claude-code/2.1.223/kickoff-channel-race"
);

const fixture = (name: string): string =>
  readFileSync(join(FIXTURE_DIR, name), "utf8");

// The exact composer body the launcher captured after its own paste, taken from
// the real 2.1.223 capture rather than hand-written.
const CAPTURED_KICKOFF_BODY = "[Pasted text #1 +6 lines]";

const PROVEN_HEALTHY = [{ major: 2, minor: 1, patch: 220 }];
const AFFECTED_VERSION = { major: 2, minor: 1, patch: 223 };

const evidence = (
  hookFixture: string,
  transcriptVersion = ""
): {
  hookSequence: number;
  sawUserPromptSubmit: boolean;
  transcriptVersion: string;
} => ({ ...parseClaudeHookEvidence(fixture(hookFixture)), transcriptVersion });

describe("parseClaudeHookEvidence", () => {
  test("reads the run-147 producer stream as a session that never submitted", () => {
    const parsed = parseClaudeHookEvidence(
      fixture("run-147-hooks-claude.jsonl")
    );
    expect(parsed.sawUserPromptSubmit).toBe(false);
    // SessionStart is not a turn-progress event, so it contributes no sequence.
    expect(parsed.hookSequence).toBe(0);
  });

  test("reads the run-148 producer stream as a session that did submit", () => {
    const parsed = parseClaudeHookEvidence(
      fixture("run-148-hooks-claude.jsonl")
    );
    expect(parsed.sawUserPromptSubmit).toBe(true);
    expect(parsed.hookSequence).toBe(2);
  });

  test("ignores blank, trailing partial, and malformed lines without throwing", () => {
    const parsed = parseClaudeHookEvidence(
      '\n{"event":"PreToolUse","sequence":3}\n{"event":"UserPrompt\n\nnot json\n'
    );
    expect(parsed.hookSequence).toBe(3);
    expect(parsed.sawUserPromptSubmit).toBe(false);
  });

  test("does not count a bare working state as turn progress", () => {
    const parsed = parseClaudeHookEvidence(
      '{"event":"SessionStart","state":"working","sequence":9}'
    );
    expect(parsed.hookSequence).toBe(0);
    expect(parsed.sawUserPromptSubmit).toBe(false);
  });

  test("treats a missing hook file as no evidence rather than an error", () => {
    expect(parseClaudeHookEvidence(undefined)).toEqual({
      hookSequence: 0,
      sawUserPromptSubmit: false,
    });
  });
});

describe("kickoffTurnStarted", () => {
  const baseline = {
    hookSequence: 0,
    sawUserPromptSubmit: false,
    transcriptVersion: "v1",
  };

  test("run-147 evidence never counts as a started turn", () => {
    expect(
      kickoffTurnStarted(
        baseline,
        evidence("run-147-hooks-claude.jsonl", "v1"),
        "kickoff-owned"
      )
    ).toBe(false);
  });

  test("run-148 evidence counts as a started turn on hooks alone", () => {
    // A UserPromptSubmit the baseline did not have is the strongest signal and
    // stands on its own, whatever the composer looks like.
    expect(
      kickoffTurnStarted(
        baseline,
        evidence("run-148-hooks-claude.jsonl", "v1"),
        "kickoff-owned"
      )
    ).toBe(true);
  });

  test("a newer transcript version alone is NOT confirmation", () => {
    // The version is size:mtimeMs on Claude's project transcript, which also
    // moves when session metadata grows after SessionStart. On its own it
    // cannot prove the kickoff submitted.
    expect(
      kickoffTurnStarted(
        baseline,
        { ...baseline, transcriptVersion: "v2" },
        "kickoff-owned"
      )
    ).toBe(false);
  });

  test("a newer transcript version confirms only with a cleared composer", () => {
    expect(
      kickoffTurnStarted(
        baseline,
        { ...baseline, transcriptVersion: "v2" },
        "empty"
      )
    ).toBe(true);
  });

  test("a cleared composer alone, with no new transcript version, is not confirmation", () => {
    expect(kickoffTurnStarted(baseline, { ...baseline }, "empty")).toBe(false);
  });

  test("an unreadable Claude transcript version never confirms", () => {
    expect(
      kickoffTurnStarted(
        baseline,
        { ...baseline, transcriptVersion: "" },
        "empty"
      )
    ).toBe(false);
  });

  test("a pre-existing UserPromptSubmit in the baseline is not confirmation", () => {
    const submitted = {
      hookSequence: 2,
      sawUserPromptSubmit: true,
      transcriptVersion: "v1",
    };
    expect(kickoffTurnStarted(submitted, submitted, "kickoff-owned")).toBe(
      false
    );
  });

  test("a truncated or rotated hook file reads as no progress, not growth", () => {
    const before = {
      hookSequence: 7,
      sawUserPromptSubmit: true,
      transcriptVersion: "v1",
    };
    const rotated = { ...before, hookSequence: 1 };
    expect(kickoffTurnStarted(before, rotated, "kickoff-owned")).toBe(false);
  });
});

describe("turn-progress event set", () => {
  const withEvent = (event: string, sequence: number): string =>
    `{"agent":"claude","event":"${event}","sequence":${sequence}}`;

  test("PreToolUse and PostToolUse imply a submitted turn", () => {
    for (const event of ["PreToolUse", "PostToolUse"]) {
      expect(parseClaudeHookEvidence(withEvent(event, 5)).hookSequence).toBe(5);
    }
  });

  test("Notification and Stop are not turn progress", () => {
    // hooks/emit.ts::lifecycleState maps both to input-required, so either can
    // fire without proving this kickoff began.
    for (const event of ["Notification", "Stop"]) {
      expect(parseClaudeHookEvidence(withEvent(event, 5)).hookSequence).toBe(0);
    }
  });
});

describe("parseClaudeCliVersion", () => {
  test("parses the observed 2.1.223 version banner", () => {
    expect(parseClaudeCliVersion("2.1.223 (Claude Code)")).toEqual(
      AFFECTED_VERSION
    );
  });

  test("returns undefined for absent or unparseable output", () => {
    expect(parseClaudeCliVersion(undefined)).toBeUndefined();
    expect(parseClaudeCliVersion("")).toBeUndefined();
    expect(parseClaudeCliVersion("command not found")).toBeUndefined();
  });
});

describe("resolveKickoffCapability", () => {
  test("requires confirmation on every version, including unknown ones", () => {
    for (const version of [
      undefined,
      { major: 1, minor: 0, patch: 0 },
      PROVEN_HEALTHY[0],
      AFFECTED_VERSION,
      { major: 99, minor: 0, patch: 0 },
    ]) {
      expect(
        resolveKickoffCapability(version, PROVEN_HEALTHY).confirmRequired
      ).toBe(true);
    }
  });

  test("exempts recovery only on an exact producer-proven-healthy version", () => {
    expect(
      resolveKickoffCapability(PROVEN_HEALTHY[0], PROVEN_HEALTHY)
        .recoveryAllowed
    ).toBe(false);
  });

  test("guards versions below the proven-healthy one instead of assuming a range", () => {
    // The `<=` range this replaced would have exempted 2.1.219 on the strength
    // of a single 2.1.220 capture. Ordering is not capability evidence.
    expect(
      resolveKickoffCapability(
        { major: 2, minor: 1, patch: 219 },
        PROVEN_HEALTHY
      ).recoveryAllowed
    ).toBe(true);
    expect(
      resolveKickoffCapability({ major: 1, minor: 0, patch: 0 }, PROVEN_HEALTHY)
        .recoveryAllowed
    ).toBe(true);
  });

  test("allows recovery for the affected 2.1.223 build", () => {
    expect(
      resolveKickoffCapability(AFFECTED_VERSION, PROVEN_HEALTHY).recoveryAllowed
    ).toBe(true);
  });

  test("defaults unknown and future versions to the guarded profile", () => {
    expect(
      resolveKickoffCapability(undefined, PROVEN_HEALTHY).recoveryAllowed
    ).toBe(true);
    expect(
      resolveKickoffCapability({ major: 3, minor: 0, patch: 0 }, PROVEN_HEALTHY)
        .recoveryAllowed
    ).toBe(true);
  });

  test("an empty proven-healthy set guards everything", () => {
    expect(
      resolveKickoffCapability(PROVEN_HEALTHY[0], []).recoveryAllowed
    ).toBe(true);
  });
});

describe("readComposerBody", () => {
  test("extracts the captured stranded kickoff body from real pane bytes", () => {
    expect(readComposerBody(fixture("02-stranded-kickoff-composer.txt"))).toBe(
      CAPTURED_KICKOFF_BODY
    );
  });

  test("returns undefined when no composer prompt is visible", () => {
    expect(readComposerBody("no prompt marker anywhere")).toBeUndefined();
    expect(readComposerBody(undefined)).toBeUndefined();
  });
});

describe("classifyKickoffComposer", () => {
  test("classifies the captured idle composer as empty despite its suggestion", () => {
    expect(
      classifyKickoffComposer({
        paneText: fixture("01-ready-with-channel-error.txt"),
        expectedComposerBody: CAPTURED_KICKOFF_BODY,
      })
    ).toBe("empty");
  });

  test("classifies the captured stranded kickoff as launcher-owned", () => {
    expect(
      classifyKickoffComposer({
        paneText: fixture("02-stranded-kickoff-composer.txt"),
        expectedComposerBody: CAPTURED_KICKOFF_BODY,
      })
    ).toBe("kickoff-owned");
  });

  test("refuses a captured composer holding an unrelated human draft", () => {
    expect(
      classifyKickoffComposer({
        paneText: fixture("03-kickoff-plus-human-draft.txt"),
        expectedComposerBody: CAPTURED_KICKOFF_BODY,
      })
    ).toBe("foreign");
  });

  test("refuses somebody else's paste that renders the same generic marker", () => {
    // Same `[Pasted text #N +M lines]` shape, different captured body. A marker
    // regex would have called this ours; exact provenance does not.
    expect(
      classifyKickoffComposer({
        paneText: fixture("02-stranded-kickoff-composer.txt"),
        expectedComposerBody: "[Pasted text #2 +40 lines]",
      })
    ).toBe("foreign");
  });

  test("refuses recovery when the launcher never captured its own paste", () => {
    expect(
      classifyKickoffComposer({
        paneText: fixture("02-stranded-kickoff-composer.txt"),
        expectedComposerBody: undefined,
      })
    ).toBe("indeterminate");
  });

  test("returns indeterminate when no composer prompt is visible", () => {
    expect(
      classifyKickoffComposer({
        paneText: "no prompt marker anywhere",
        expectedComposerBody: CAPTURED_KICKOFF_BODY,
      })
    ).toBe("indeterminate");
    expect(
      classifyKickoffComposer({
        paneText: undefined,
        expectedComposerBody: CAPTURED_KICKOFF_BODY,
      })
    ).toBe("indeterminate");
  });
});

describe("producer fixture provenance", () => {
  test("every fixture file listed in fixture-index.json matches its recorded sha256", () => {
    const index = JSON.parse(fixture("fixture-index.json")) as {
      artifacts: { file: string; sha256: string }[];
    };
    expect(index.artifacts.length).toBeGreaterThan(0);
    for (const artifact of index.artifacts) {
      const bytes = readFileSync(join(FIXTURE_DIR, artifact.file));
      const digest = createHash("sha256").update(bytes).digest("hex");
      expect(`${artifact.file}:${digest}`).toBe(
        `${artifact.file}:${artifact.sha256}`
      );
    }
  });
});
