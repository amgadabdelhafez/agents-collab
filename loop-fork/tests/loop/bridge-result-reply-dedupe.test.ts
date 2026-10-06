import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BridgeEnqueueOptions,
  type BridgeSource,
  type BridgeTarget,
  enqueueBridgeMessage,
  markBridgeMessage,
  readBridgeEvents,
  readPendingBridgeMessages,
} from "../../src/loop/bridge-store";

// Claude hears one inbound through two notification paths on purpose (the MCP
// channel and the tmux doorbell, e4efbae2). Its result replies are therefore
// one durable effect per inbound message and reply kind.

const withRun = (name: string, body: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), `bridge-result-${name}-`));
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const messages = (root: string) =>
  readBridgeEvents(root).filter((event) => event.kind === "message");

const reply = (
  root: string,
  text: string,
  options: BridgeEnqueueOptions,
  source: BridgeSource = "claude",
  target: BridgeTarget = "codex"
) => enqueueBridgeMessage(root, source, target, text, options);

const consume = (
  root: string,
  entry: ReturnType<typeof reply>["entry"]
): void => markBridgeMessage(root, entry, "delivered", "read via receive");

test("a duplicate Claude result reply for one inbound produces one effect", () => {
  withRun("one-effect", (root) => {
    const first = reply(root, "result A", { replyTo: "inbound-1" });
    consume(root, first.entry);
    // The same inbound rang again (channel retry or tmux doorbell) and Claude
    // acted on it again: a reworded result is not a second delivered effect.
    const again = reply(root, "result B", { replyTo: "inbound-1" });
    expect(first.status).toBe("queued");
    expect(again.status).toBe("duplicate");
    expect(again.entry.id).toBe(first.entry.id);
    expect(again.entry.message).toBe("result A");
    expect(messages(root)).toHaveLength(1);
    expect(readPendingBridgeMessages(root)).toHaveLength(0);
  });
});

test("a stable caller dedupe key stays one effect after consumption, even with supersede", () => {
  withRun("keyed", (root) => {
    const options = { dedupeKey: "result:inbound-1", replyTo: "inbound-1" };
    const first = reply(root, "one", options);
    consume(root, first.entry);
    const again = reply(root, "two", { ...options, supersede: true });
    expect(again.status).toBe("duplicate");
    expect(again.entry.id).toBe(first.entry.id);
    expect(messages(root)).toHaveLength(1);
  });
});

test("a still-pending Claude result reply may be superseded, leaving one effect", () => {
  withRun("supersede", (root) => {
    const first = reply(root, "draft", { replyTo: "inbound-1" });
    const corrected = reply(root, "corrected", {
      replyTo: "inbound-1",
      supersede: true,
    });
    expect(corrected.status).toBe("queued");
    expect(readPendingBridgeMessages(root).map((entry) => entry.id)).toEqual([
      corrected.entry.id,
    ]);
    expect(
      readBridgeEvents(root).some(
        (event) => event.kind === "superseded" && event.id === first.entry.id
      )
    ).toBe(true);
  });
});

test("a progress reply then a result reply to one inbound both deliver", () => {
  withRun("progress-result", (root) => {
    const progress = reply(root, "progress: tests running", {
      dedupeKey: "progress:inbound-1",
      replyTo: "inbound-1",
    });
    consume(root, progress.entry);
    const result = reply(root, "result: PASS", {
      dedupeKey: "result:inbound-1",
      replyTo: "inbound-1",
    });
    expect(progress.status).toBe("queued");
    expect(result.status).toBe("queued");
    expect(result.entry.id).not.toBe(progress.entry.id);
    consume(root, result.entry);
    // Each kind keeps its own slot: repeating either is still one effect.
    expect(
      reply(root, "progress again", {
        dedupeKey: "progress:inbound-1",
        replyTo: "inbound-1",
      }).status
    ).toBe("duplicate");
    expect(
      reply(root, "result again", {
        dedupeKey: "result:inbound-1",
        replyTo: "inbound-1",
      }).status
    ).toBe("duplicate");
    expect(messages(root)).toHaveLength(2);
  });
});

test("a decision after a message reply to one inbound is a distinct effect", () => {
  withRun("kinds", (root) => {
    const message = reply(root, "clarifying note", { replyTo: "inbound-1" });
    consume(root, message.entry);
    const decision = reply(root, "PASS", {
      replyTo: "inbound-1",
      type: "decision",
    });
    expect(decision.status).toBe("queued");
    consume(root, decision.entry);
    expect(
      reply(root, "PASS again", { replyTo: "inbound-1", type: "decision" })
        .status
    ).toBe("duplicate");
    expect(messages(root)).toHaveLength(2);
  });
});

test("result reply slots stay scoped to sender, target and inbound", () => {
  withRun("scope", (root) => {
    const options = { replyTo: "inbound-1" };
    expect(reply(root, "ack", { ...options, type: "ack" }).status).toBe(
      "queued"
    );
    expect(reply(root, "result", options).status).toBe("queued");
    expect(
      reply(root, "to supervisor", options, "claude", "supervisor").status
    ).toBe("queued");
    expect(reply(root, "other inbound", { replyTo: "inbound-2" }).status).toBe(
      "queued"
    );
    // Messages without reply_to keep their existing behaviour.
    expect(reply(root, "free text", {}).status).toBe("queued");
    expect(reply(root, "free text", {}).status).toBe("queued");
  });
});

test("Claude replies that open new work are not result slots", () => {
  withRun("non-result", (root) => {
    for (const type of [
      "work_request",
      "review_request",
      "handover",
      "escalation",
    ] as const) {
      const first = reply(root, `${type} 1`, { replyTo: "inbound-1", type });
      consume(root, first.entry);
      expect(
        reply(root, `${type} 2`, { replyTo: "inbound-1", type }).status
      ).toBe("queued");
    }
  });
});

test("Codex and oss result replies keep their existing non-durable semantics", () => {
  withRun("other-senders", (root) => {
    for (const source of ["codex", "oss"] as const) {
      const first = reply(
        root,
        `${source} result A`,
        { replyTo: "inbound-1" },
        source,
        "claude"
      );
      consume(root, first.entry);
      expect(
        reply(
          root,
          `${source} result B`,
          { replyTo: "inbound-1" },
          source,
          "claude"
        ).status
      ).toBe("queued");
    }
  });
});

// Fill the codex queue to the default 32-message limit with unrelated traffic.
const fillCodexQueue = (root: string) =>
  Array.from({ length: 32 }, (_, index) => {
    const filler = enqueueBridgeMessage(
      root,
      "claude",
      "codex",
      `filler ${index}`,
      { maxOutstanding: 64 }
    );
    expect(filler.status).toBe("queued");
    return filler.entry;
  });

test("a dead-lettered earlier result reply does not block a retry", () => {
  withRun("dead-letter", (root) => {
    const fillers = fillCodexQueue(root);
    const lost = reply(root, "result", { replyTo: "inbound-1" });
    expect(lost.status).toBe("dead-letter");
    for (const filler of fillers) {
      consume(root, filler);
    }
    const retry = reply(root, "result", { replyTo: "inbound-1" });
    expect(retry.status).toBe("queued");
    expect(retry.entry.id).not.toBe(lost.entry.id);
    expect(readPendingBridgeMessages(root).map((entry) => entry.id)).toEqual([
      retry.entry.id,
    ]);
    // Once the retry has had its effect, the inbound's result slot holds.
    consume(root, retry.entry);
    expect(reply(root, "result", { replyTo: "inbound-1" }).status).toBe(
      "duplicate"
    );
  });
});

test("an expired earlier result reply does not block a retry", () => {
  withRun("expired", (root) => {
    const first = reply(root, "result", {
      now: "2026-10-05T10:00:00.000Z",
      replyTo: "inbound-1",
      ttlMs: 1000,
    });
    expect(first.status).toBe("queued");
    const retryAt = "2026-10-05T10:00:05.000Z";
    const retry = reply(root, "result", { now: retryAt, replyTo: "inbound-1" });
    expect(retry.status).toBe("queued");
    expect(
      readBridgeEvents(root).some(
        (event) => event.kind === "expired" && event.id === first.entry.id
      )
    ).toBe(true);
    expect(
      readPendingBridgeMessages(root, Date.parse(retryAt)).map(
        (entry) => entry.id
      )
    ).toEqual([retry.entry.id]);
  });
});

test("a superseded reply whose replacement was dead-lettered does not block a retry", () => {
  withRun("superseded-dead-letter", (root) => {
    const draft = reply(root, "draft", { replyTo: "inbound-1" });
    expect(draft.status).toBe("queued");
    fillCodexQueue(root);
    // The draft is superseded, then the replacement meets a full queue.
    const replacement = reply(root, "corrected", {
      replyTo: "inbound-1",
      supersede: true,
    });
    expect(replacement.status).toBe("dead-letter");
    expect(
      readBridgeEvents(root).some(
        (event) => event.kind === "superseded" && event.id === draft.entry.id
      )
    ).toBe(true);
    for (const entry of readPendingBridgeMessages(root)) {
      consume(root, entry);
    }
    expect(reply(root, "corrected", { replyTo: "inbound-1" }).status).toBe(
      "queued"
    );
  });
});

// ACK slots predate this change and cover every sender. Excluding no-effect
// ACKs from that lookup is a deliberate change for Codex and oss ACKs too.
test("a dead-lettered ACK from Claude or Codex does not block a retry", () => {
  for (const source of ["claude", "codex"] as const) {
    withRun(`ack-dead-letter-${source}`, (root) => {
      const target = source === "claude" ? "codex" : "claude";
      for (let index = 0; index < 32; index += 1) {
        reply(root, `filler ${index}`, { maxOutstanding: 64 }, source, target);
      }
      const ack = { replyTo: "inbound-1", type: "ack" as const };
      expect(reply(root, "ack", ack, source, target).status).toBe(
        "dead-letter"
      );
      for (const entry of readPendingBridgeMessages(root)) {
        consume(root, entry);
      }
      const retry = reply(root, "ack", ack, source, target);
      expect(retry.status).toBe("queued");
      consume(root, retry.entry);
      expect(reply(root, "ack again", ack, source, target).status).toBe(
        "duplicate"
      );
    });
  }
});
