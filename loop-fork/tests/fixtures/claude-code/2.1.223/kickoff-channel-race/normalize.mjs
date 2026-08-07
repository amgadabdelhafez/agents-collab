#!/usr/bin/env node
// Deterministic normalizer for the 2.1.223 kickoff-channel-race producer fixture.
//
// Inputs are raw `tmux capture-pane -p` output and raw `<runDir>/hooks/claude.jsonl`
// bodies. The transform is intentionally tiny and reviewable so the checked-in
// bytes stay traceable to the producer capture:
//
//   1. CRLF -> LF, trailing whitespace stripped per line (tmux right-pads every
//      row to the pane width, which is volatile), exactly one trailing newline.
//   2. Ordered literal substitutions replacing machine-, user-, and run-specific
//      text with placeholders.
//   3. In `pane` mode the substitutions are width-preserving, because Claude
//      Code emits box-drawing layout that would visibly skew otherwise. In
//      `jsonl` mode width does not matter and is not enforced.
//
// Every substitution is listed in fixture-index.json under `normalization`.
// Usage: node normalize.mjs <pane|jsonl> <source-file> <destination-file>

import { readFileSync, writeFileSync } from "node:fs";

// Width-preserving: `to` MUST be the same length as `from`.
export const PANE_SUBSTITUTIONS = [
  ["Welcome back Amgad!", "Welcome back Guest!"],
  ["Claude Pro · CEO", "Claude Pro · dev"],
  [
    "/…/scratchpad/kickoff-fixture-odRVF4/repo",
    "/…/fixtures/2.1.223/kickoff-channel-race/",
  ],
];

// Free-width: JSON payloads carry no layout.
export const JSONL_SUBSTITUTIONS = [
  ["/private/tmp/harvto-loop142-base", "<REPO_ROOT>"],
];

const TRAILING_WHITESPACE_RE = /[ \t]+$/u;

export const normalize = (raw, mode) => {
  let text = raw.replaceAll("\r\n", "\n");
  const substitutions =
    mode === "pane" ? PANE_SUBSTITUTIONS : JSONL_SUBSTITUTIONS;
  for (const [from, to] of substitutions) {
    if (mode === "pane" && from.length !== to.length) {
      throw new Error(`normalize: pane substitution changes width: ${from}`);
    }
    text = text.replaceAll(from, to);
  }
  const lines = text
    .split("\n")
    .map((line) => line.replace(TRAILING_WHITESPACE_RE, ""));
  while (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return `${lines.join("\n")}\n`;
};

const [, , mode, source, destination] = process.argv;
if (mode && source && destination) {
  if (mode !== "pane" && mode !== "jsonl") {
    throw new Error(`normalize: unknown mode "${mode}"`);
  }
  writeFileSync(destination, normalize(readFileSync(source, "utf8"), mode));
}
