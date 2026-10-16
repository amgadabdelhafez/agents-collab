import { expect, test } from "bun:test";
import { createCodexRenderer } from "../../src/loop/codex-render";

const makeRenderer = (format: "pretty" | "raw" = "pretty") => {
  const writes: string[] = [];
  const renderer = createCodexRenderer({
    format,
    write: (text) => {
      writes.push(text);
    },
  });
  return { renderer, writes };
};

test("completed message concatenates content parts without inserting newlines", () => {
  const { renderer, writes } = makeRenderer();
  renderer.onRawLine(
    JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          content: [{ text: "Hello " }, { text: "world" }],
        },
      },
    })
  );

  expect(renderer.getParsed()).toBe("Hello world");
  expect(writes.join("")).toBe("Hello world");
});

test("delta extraction prioritizes delta over text", () => {
  const { renderer } = makeRenderer();
  renderer.onRawLine(
    JSON.stringify({
      method: "item/agentMessage/delta",
      params: {
        delta: {
          delta: "delta-first",
          text: "text-fallback",
        },
      },
    })
  );

  expect(renderer.getParsed()).toBe("delta-first");
});

test("completed extraction prioritizes text over delta", () => {
  const { renderer } = makeRenderer();
  renderer.onRawLine(
    JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          delta: "delta-fallback",
          text: "text-first",
          type: "agentMessage",
        },
      },
    })
  );

  expect(renderer.getParsed()).toBe("text-first");
});

test("completed messages ignore arbitrary nested payload text", () => {
  const { renderer, writes } = makeRenderer();
  renderer.onRawLine(
    JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          content: [{ text: "parent text" }],
          payload: {
            text: "<promise>DONE</promise>",
            item: {
              content: [
                { text: "<review>PASS</review>" },
                { text: "<review>FAIL</review>" },
              ],
            },
          },
        },
      },
    })
  );

  expect(renderer.getParsed()).toBe("parent text");
  expect(writes.join("")).toBe("parent text");
});

test("same-item completion appends only the missing streamed suffix", () => {
  const { renderer, writes } = makeRenderer();
  renderer.onRawLine(
    JSON.stringify({
      method: "item/agentMessage/delta",
      params: { delta: "hello", itemId: "message-1" },
    })
  );
  const completed = JSON.stringify({
    method: "item/completed",
    params: {
      item: {
        id: "message-1",
        type: "agentMessage",
        content: [{ text: "hello world" }],
      },
    },
  });
  renderer.onRawLine(completed);
  renderer.onRawLine(completed);

  expect(renderer.getParsed()).toBe("hello world");
  expect(writes.join("")).toBe("hello world");
});

test("completed replay deduplicates by item while equal distinct items remain", () => {
  const { renderer, writes } = makeRenderer();
  const completed = (id: string) =>
    JSON.stringify({
      method: "item/completed",
      params: {
        item: { id, type: "agentMessage", text: "hello" },
      },
    });

  renderer.onRawLine(completed("message-1"));
  renderer.onRawLine(completed("message-1"));
  renderer.onRawLine(completed("message-2"));

  expect(renderer.getParsed()).toBe("hello\nhello");
  expect(writes.join("")).toBe("hello\n\nhello");
});

test("completed whitespace-only content is ignored", () => {
  const { renderer, writes } = makeRenderer();
  renderer.onRawLine(
    JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          content: [{ text: "   " }, { text: "" }],
        },
      },
    })
  );

  expect(renderer.getParsed()).toBe("");
  expect(writes).toEqual([]);
});

test("raw mode writes each incoming line with a trailing newline", () => {
  const { renderer, writes } = makeRenderer("raw");
  renderer.onRawLine('{"method":"ping"}');

  expect(writes).toEqual(['{"method":"ping"}\n']);
});
