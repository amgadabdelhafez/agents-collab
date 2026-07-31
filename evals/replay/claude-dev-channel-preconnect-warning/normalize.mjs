#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const [rawRoot, outputRoot] = process.argv.slice(2);
if (!(rawRoot && outputRoot)) {
  throw new Error("usage: normalize.mjs <raw-capture-root> <fixture-output-root>");
}

const selectedStates = [
  ["bypass-default", "01-bypass-default.txt"],
  ["bypass-accepted", "02-bypass-accepted.txt"],
  ["development-channel", "03-development-channel.txt"],
  ["ready-before-end-clear", "04-ready-with-preconnect-warning.txt"],
  ["ready-after-end-clear", "05-ready-after-end-clear.txt"],
  ["draft-home", "06-draft-home.txt"],
  ["draft-after-end-clear", "07-draft-after-end-clear.txt"],
  ["draft-home-restored", "08-draft-home-restored.txt"],
  ["draft-cleared", "09-draft-cleared.txt"],
];
const unsentDraft = 'Try "do not overwrite this human draft"';
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const parseTsv = (path) => {
  const [header, ...lines] = readFileSync(path, "utf8").trim().split("\n");
  const fields = header.split("\t");
  return lines.map((line) => {
    const values = line.split("\t");
    if (values.length !== fields.length) {
      throw new Error(`invalid TSV row in ${path}: ${line}`);
    }
    return Object.fromEntries(fields.map((field, index) => [field, values[index]]));
  });
};

const parseEnvironment = (path) =>
  Object.fromEntries(
    readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1) {
          throw new Error(`invalid environment record: ${line}`);
        }
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );

const requireEnvironmentValue = (environment, key, expected) => {
  if (environment[key] !== expected) {
    throw new Error(
      `unexpected private environment value for ${key}: ${environment[key]}`
    );
  }
};

const asUint = (value, field, state) => {
  if (!/^\d+$/.test(value)) {
    throw new Error(`non-numeric ${field} for ${state}: ${value}`);
  }
  return Number.parseInt(value, 10);
};

const normalize = (raw) =>
  raw
    .replace(/Welcome back [^!\n]+!/g, "Welcome back <USER>!")
    .replace(
      /Opus 5 with max effort · [^│\n]+/g,
      "Opus 5 with max effort · <ACCOUNT_CONTEXT>  "
    )
    .replace(/\/Users\/[^/\s]+/g, "<HOME>")
    .replaceAll("/private/tmp", "<CAPTURE_CWD>");

const selectedManifestPath = join(rawRoot, "selected-states.tsv");
const actionsPath = join(rawRoot, "actions.tsv");
const environment = parseEnvironment(join(rawRoot, "environment.txt"));
const selectedRows = parseTsv(selectedManifestPath);
const actions = parseTsv(actionsPath).map((action) => ({
  action: action.action,
  phase: action.phase,
  promptSubmission: action.prompt_submission === "true",
}));

const actualStates = selectedRows.map((row) => row.state);
const expectedStates = selectedStates.map(([state]) => state);
if (JSON.stringify(actualStates) !== JSON.stringify(expectedStates)) {
  throw new Error(
    `selected producer states differ: ${actualStates.join(", ")}`
  );
}
if (actions.some((action) => action.promptSubmission)) {
  throw new Error("capture action manifest records a prompt submission");
}
for (const [key, expected] of [
  ["prompt_submitted", "false"],
  ["model_request_made", "false"],
  ["pane_pipe_requested", "false"],
  ["draft_cleared", "true"],
]) {
  requireEnvironmentValue(environment, key, expected);
}

mkdirSync(outputRoot, { recursive: true });
const frames = selectedStates.map(([state, normalizedFile], index) => {
  const row = selectedRows[index];
  const rawFile = row.raw_file;
  if (isAbsolute(rawFile) || rawFile.split("/").includes("..")) {
    throw new Error(`unsafe raw file reference for ${state}: ${rawFile}`);
  }
  const raw = readFileSync(join(rawRoot, rawFile));
  const normalized = Buffer.from(normalize(raw.toString("utf8")), "utf8");
  const normalizedText = normalized.toString("utf8");
  if (
    /\/Users\//.test(normalizedText) ||
    /Welcome back (?!<USER>)/.test(normalizedText) ||
    normalizedText.includes("API Usage Billing") ||
    normalizedText.includes("· CEO")
  ) {
    throw new Error(`sensitive capture text remains in ${rawFile}`);
  }
  writeFileSync(join(outputRoot, normalizedFile), normalized);
  return {
    activeClients: asUint(row.active_clients, "active_clients", state),
    capturedAtUtc: row.captured_at_utc,
    cursor: {
      paneHeight: asUint(row.pane_height, "pane_height", state),
      paneWidth: asUint(row.pane_width, "pane_width", state),
      x: asUint(row.cursor_x, "cursor_x", state),
      y: asUint(row.cursor_y, "cursor_y", state),
    },
    normalizedFile,
    normalizedSha256: sha256(normalized),
    paneId: row.pane_id,
    panePipe: asUint(row.pane_pipe, "pane_pipe", state),
    paneTarget: row.pane_target,
    rawSha256: sha256(raw),
    sourceFrame: row.source_frame,
    state,
    windowActivity: asUint(row.window_activity, "window_activity", state),
  };
});

const frameByState = Object.fromEntries(
  frames.map((frame) => [frame.state, frame])
);
const boundPaneTargets = new Set(frames.map((frame) => frame.paneTarget));
const boundPaneIds = new Set(frames.map((frame) => frame.paneId));
if (boundPaneTargets.size !== 1 || boundPaneIds.size !== 1) {
  throw new Error("selected producer states are not bound to one tmux pane");
}
if (
  frames.some(
    (frame) =>
      frame.activeClients !== 0 ||
      frame.panePipe !== 0 ||
      frame.cursor.paneWidth !== 220 ||
      frame.cursor.paneHeight !== 60
  )
) {
  throw new Error("capture is not detached, unpiped, and 220x60");
}

const readyBefore = frameByState["ready-before-end-clear"];
const readyAfter = frameByState["ready-after-end-clear"];
const draftHome = frameByState["draft-home"];
const draftAfter = frameByState["draft-after-end-clear"];
const draftRestored = frameByState["draft-home-restored"];
const draftCleared = frameByState["draft-cleared"];
if (
  readyAfter.windowActivity <= readyBefore.windowActivity ||
  draftAfter.windowActivity <= draftHome.windowActivity ||
  draftRestored.windowActivity <= draftAfter.windowActivity
) {
  throw new Error("captured probe or restoration activity did not advance");
}
if (
  readyBefore.cursor.x !== 2 ||
  readyAfter.cursor.x !== 2 ||
  draftHome.cursor.x !== 2 ||
  draftAfter.cursor.x <= 2 ||
  draftRestored.cursor.x !== 2 ||
  draftCleared.cursor.x !== 2
) {
  throw new Error("captured cursor states do not prove draft preservation");
}
for (const [key, expected] of [
  ["ready_activity_before", String(readyBefore.windowActivity)],
  ["ready_activity_after", String(readyAfter.windowActivity)],
  ["draft_activity_before", String(draftHome.windowActivity)],
  ["draft_activity_after", String(draftAfter.windowActivity)],
  ["draft_restore_activity_before", String(draftAfter.windowActivity)],
  ["draft_restore_activity_after", String(draftRestored.windowActivity)],
  ["draft_sha256", sha256(unsentDraft)],
]) {
  requireEnvironmentValue(environment, key, expected);
}

const normalizedTextByState = Object.fromEntries(
  frames.map((frame) => [
    frame.state,
    readFileSync(join(outputRoot, frame.normalizedFile), "utf8"),
  ])
);
for (const state of [
  "draft-home",
  "draft-after-end-clear",
  "draft-home-restored",
]) {
  if (!normalizedTextByState[state].includes(unsentDraft)) {
    throw new Error(`unsent draft is missing from ${state}`);
  }
}
for (const state of [
  "ready-before-end-clear",
  "ready-after-end-clear",
  "draft-cleared",
]) {
  if (normalizedTextByState[state].includes(unsentDraft)) {
    throw new Error(`unsent draft remains in ${state}`);
  }
}

const fixtureIndex = {
  actions,
  activityProbe: {
    draftSha256: sha256(unsentDraft),
    draftStates: {
      afterEndClear: "draft-after-end-clear",
      cleared: "draft-cleared",
      home: "draft-home",
      restoredHome: "draft-home-restored",
    },
    readyStates: {
      afterEndClear: "ready-after-end-clear",
      beforeEndClear: "ready-before-end-clear",
    },
    unsentDraft,
  },
  captureRepresentation: "tmux capture-pane -p -e",
  captureSafety: {
    modelRequestMade: false,
    panePipeRequested: false,
    promptSubmitted: false,
  },
  frames,
  normalization: [
    "replace welcome identity with <USER>",
    "replace account plan and role with <ACCOUNT_CONTEXT>",
    "replace macOS home prefixes with <HOME>",
    "replace capture cwd with <CAPTURE_CWD>",
  ],
  rawManifests: {
    actionsSha256: sha256(readFileSync(actionsPath)),
    environmentSha256: sha256(readFileSync(join(rawRoot, "environment.txt"))),
    mcpConfigSha256: sha256(readFileSync(join(rawRoot, "claude-mcp.json"))),
    selectedStatesSha256: sha256(readFileSync(selectedManifestPath)),
  },
  rawReference: environment.raw_reference,
  schemaVersion: 2,
};
const publicBytes = Buffer.from(`${JSON.stringify(fixtureIndex, null, 2)}\n`);
if (
  /\/Users\/|\/private\/tmp\/agents-collab-|\/opt\/homebrew\//.test(
    publicBytes.toString("utf8")
  )
) {
  throw new Error("machine-specific path remains in fixture index");
}
writeFileSync(join(outputRoot, "fixture-index.json"), publicBytes);
