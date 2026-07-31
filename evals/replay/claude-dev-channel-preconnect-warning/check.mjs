#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const replayDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(replayDir, "..", "..", "..");
const fixtureDir = join(
  repoRoot,
  "loop-fork",
  "tests",
  "fixtures",
  "claude-code",
  "2.1.220",
  "dev-channel-preconnect-warning"
);
const fixtureIndexPath = join(fixtureDir, "fixture-index.json");
const indexBytes = readFileSync(fixtureIndexPath);
const index = JSON.parse(indexBytes.toString("utf8"));
const provenancePath = join(replayDir, "provenance.json");
const provenanceBytes = readFileSync(provenancePath);
const provenance = JSON.parse(provenanceBytes.toString("utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const isSha256 = (value) => /^[a-f0-9]{64}$/.test(value);
const machineSpecificPath =
  /\/Users\/|\/private\/tmp\/agents-collab-|\/opt\/homebrew\//;
const unsentDraft = 'Try "do not overwrite this human draft"';
const draftSha256 = sha256(unsentDraft);

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

assert(provenance.schemaVersion === 2, "provenance schema is not current");
assert(index.schemaVersion === 2, "fixture index schema is not current");
assert(
  provenance.producer.version === "2.1.220",
  "producer version is not pinned"
);
assert(
  isSha256(provenance.producer.sha256),
  "producer executable hash is not pinned"
);
assert(
  provenance.producer.executable === "<CLAUDE_EXECUTABLE>",
  "producer executable path is not privacy-normalized"
);
assert(
  !machineSpecificPath.test(provenanceBytes.toString("utf8")),
  "machine-specific path remains in checked-in provenance"
);
assert(
  !machineSpecificPath.test(indexBytes.toString("utf8")),
  "machine-specific path remains in fixture index"
);
assert(
  provenance.capture.promptSubmitted === false &&
    provenance.capture.modelRequestMade === false &&
    provenance.capture.panePipeRequested === false,
  "capture safety flags do not prove no prompt, model request, or pipe"
);
assert(
  index.captureSafety?.promptSubmitted === false &&
    index.captureSafety?.modelRequestMade === false &&
    index.captureSafety?.panePipeRequested === false,
  "fixture safety flags do not prove no prompt, model request, or pipe"
);
assert(
  provenance.rawEvidence.reference ===
    "~/.loop/evidence/claude-warning-producer-fixture/20260731T054543Z",
  "raw evidence does not reference the fresh durable capture"
);
assert(
  index.rawReference === provenance.rawEvidence.reference,
  "fixture and provenance raw references differ"
);
assert(
  provenance.rawEvidence.permissions?.directories === "0700" &&
    provenance.rawEvidence.permissions?.files === "0600",
  "private raw permission policy is missing"
);
assert(
  index.captureRepresentation === provenance.capture.representation,
  "fixture and provenance capture representations differ"
);

for (const script of [provenance.captureScript, provenance.normalization]) {
  const scriptPath = script.path ?? script.script;
  const expectedHash = script.sha256 ?? script.scriptSha256;
  const bytes = readFileSync(join(repoRoot, scriptPath));
  assert(
    sha256(bytes) === expectedHash,
    `provenance script hash mismatch: ${scriptPath}`
  );
  assert(
    !machineSpecificPath.test(bytes.toString("utf8")),
    `machine-specific path remains in ${scriptPath}`
  );
}

const captureScript = readFileSync(
  join(repoRoot, provenance.captureScript.path),
  "utf8"
);
assert(
  captureScript.includes("umask 077"),
  "capture script does not make private permissions the default"
);
assert(
  captureScript.includes("selected-states.tsv"),
  "capture script does not write deterministic selected-state evidence"
);
assert(
  captureScript.includes("#{window_activity}") &&
    captureScript.includes("#{session_attached}") &&
    captureScript.includes("#{pane_pipe}"),
  "capture script does not record bound numeric tmux state"
);
assert(
  captureScript.includes('capture-pane -p -e -t "$pane_target" \\;') &&
    captureScript.includes("__LOOP_BOUND_STATE__ "),
  "pane bytes and numeric state are not emitted by one tmux command queue"
);
assert(
  captureScript.includes("wait_past_activity_second") &&
    captureScript.includes("ready activity did not advance") &&
    captureScript.includes("draft activity did not advance") &&
    captureScript.includes("draft restoration activity did not advance"),
  "capture script does not require activity-second advancement"
);
assert(
  captureScript.includes("send-keys -l") &&
    captureScript.includes("refusing prompt-submitting key after ready"),
  "capture script does not safely inject the unsent draft"
);
assert(
  !captureScript.includes("pipe-pane"),
  "capture script must not request a raw pane pipe"
);

const expectedFrames = [
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
assert(
  index.frames.length === expectedFrames.length,
  "fixture does not contain the complete selected producer sequence"
);

const paneTargets = new Set();
const paneIds = new Set();
const frameByState = {};
for (const [position, frame] of index.frames.entries()) {
  const [expectedState, expectedFile] = expectedFrames[position];
  assert(
    frame.state === expectedState && frame.normalizedFile === expectedFile,
    `unexpected frame order at ${position}: ${frame.state}`
  );
  assert(
    basename(frame.normalizedFile) === frame.normalizedFile,
    `fixture frame contains a path: ${frame.normalizedFile}`
  );
  assert(
    !("rawFile" in frame),
    `public fixture exposes a private raw path for ${frame.state}`
  );
  assert(
    Number.isInteger(frame.cursor?.x) &&
      Number.isInteger(frame.cursor?.y) &&
      Number.isInteger(frame.windowActivity) &&
      Number.isInteger(frame.activeClients) &&
      Number.isInteger(frame.panePipe),
    `numeric tmux evidence is invalid: ${frame.normalizedFile}`
  );
  assert(
    frame.cursor.paneWidth === provenance.capture.geometry.columns &&
      frame.cursor.paneHeight === provenance.capture.geometry.rows,
    `geometry evidence is invalid: ${frame.normalizedFile}`
  );
  assert(
    frame.activeClients === 0 && frame.panePipe === 0,
    `selected state is attached or piped: ${frame.normalizedFile}`
  );
  assert(
    typeof frame.paneTarget === "string" && /^%\d+$/.test(frame.paneId),
    `pane binding is invalid: ${frame.normalizedFile}`
  );
  assert(
    isSha256(frame.rawSha256) && isSha256(frame.normalizedSha256),
    `frame hash is invalid: ${frame.normalizedFile}`
  );

  const bytes = readFileSync(join(fixtureDir, frame.normalizedFile));
  assert(
    sha256(bytes) === frame.normalizedSha256,
    `normalized fixture hash mismatch: ${frame.normalizedFile}`
  );
  const text = bytes.toString("utf8");
  assert(
    !machineSpecificPath.test(text) &&
      !text.includes("API Usage Billing") &&
      !text.includes("· CEO") &&
      !/Welcome back (?!<USER>)/.test(text),
    `sensitive text remains: ${frame.normalizedFile}`
  );
  paneTargets.add(frame.paneTarget);
  paneIds.add(frame.paneId);
  frameByState[frame.state] = { ...frame, text };
}
assert(
  paneTargets.size === 1 && paneIds.size === 1,
  "selected states are not bound to one tmux pane"
);

const readyBefore = frameByState["ready-before-end-clear"];
const readyAfter = frameByState["ready-after-end-clear"];
const draftHome = frameByState["draft-home"];
const draftAfter = frameByState["draft-after-end-clear"];
const draftRestored = frameByState["draft-home-restored"];
const draftCleared = frameByState["draft-cleared"];
for (const ready of [readyBefore, readyAfter, draftCleared]) {
  assert(
    ready.text.includes("no MCP server configured with that name") &&
      ready.text.includes("❯"),
    `captured ready composer shape is missing: ${ready.state}`
  );
  assert(
    !ready.text.includes(unsentDraft),
    `unsent draft remains in ${ready.state}`
  );
}
for (const draft of [draftHome, draftAfter, draftRestored]) {
  assert(
    draft.text.includes(unsentDraft),
    `exact unsent draft is missing from ${draft.state}`
  );
}
assert(
  readyBefore.cursor.x === 2 && readyAfter.cursor.x === 2,
  "ready probe did not preserve the empty composer cursor"
);
assert(
  readyAfter.windowActivity > readyBefore.windowActivity,
  "ready End,C-l probe did not advance window activity"
);
assert(
  readyBefore.rawSha256 === readyAfter.rawSha256 &&
    readyBefore.normalizedSha256 === readyAfter.normalizedSha256,
  "ready End,C-l probe changed pane content"
);
assert(
  draftHome.cursor.x === 2 &&
    draftAfter.cursor.x === 2 + unsentDraft.length &&
    draftRestored.cursor.x === 2 &&
    draftCleared.cursor.x === 2,
  "draft cursor was not moved, restored, and cleared as captured"
);
assert(
  draftAfter.windowActivity > draftHome.windowActivity,
  "draft End,C-l probe did not advance window activity"
);
assert(
  draftRestored.windowActivity > draftAfter.windowActivity,
  "draft Home,C-l restoration did not advance window activity"
);
assert(
  draftHome.rawSha256 === draftAfter.rawSha256 &&
    draftHome.rawSha256 === draftRestored.rawSha256 &&
    draftHome.normalizedSha256 === draftAfter.normalizedSha256 &&
    draftHome.normalizedSha256 === draftRestored.normalizedSha256,
  "draft probe or restoration changed pane content"
);
assert(
  draftCleared.rawSha256 === readyBefore.rawSha256 &&
    draftCleared.normalizedSha256 === readyBefore.normalizedSha256,
  "cleared draft did not restore the ready pane bytes"
);

const expectedActions = [
  ["startup-bypass", "Down"],
  ["startup-bypass", "Enter"],
  ["startup-development-channel", "Enter"],
  ["ready-activity-probe", "End"],
  ["ready-activity-probe", "C-l"],
  ["draft-input", `literal-sha256:${draftSha256}`],
  ["draft-home", "Home"],
  ["draft-activity-probe", "End"],
  ["draft-activity-probe", "C-l"],
  ["draft-restore", "Home"],
  ["draft-restore", "C-l"],
  ["draft-clear", "Home"],
  ["draft-clear", "C-k"],
  ["draft-clear", "C-l"],
].map(([phase, action]) => ({ action, phase, promptSubmission: false }));
assert(
  JSON.stringify(index.actions) === JSON.stringify(expectedActions),
  "capture action order differs from the non-submitting probe protocol"
);
assert(
  index.actions
    .slice(3)
    .every(
      (action) =>
        action.promptSubmission === false &&
        action.action !== "Enter" &&
        action.action !== "C-m"
    ),
  "post-ready action could submit the unsent draft"
);
assert(
  index.activityProbe?.draftSha256 === draftSha256 &&
    index.activityProbe?.unsentDraft === unsentDraft &&
    index.activityProbe?.readyStates?.beforeEndClear ===
      "ready-before-end-clear" &&
    index.activityProbe?.readyStates?.afterEndClear ===
      "ready-after-end-clear" &&
    index.activityProbe?.draftStates?.home === "draft-home" &&
    index.activityProbe?.draftStates?.afterEndClear ===
      "draft-after-end-clear" &&
    index.activityProbe?.draftStates?.restoredHome ===
      "draft-home-restored" &&
    index.activityProbe?.draftStates?.cleared === "draft-cleared",
  "public activity-probe state binding is incomplete"
);

const rawHashes = provenance.rawEvidence.manifestHashes;
assert(
  JSON.stringify(index.rawManifests) === JSON.stringify(rawHashes),
  "public fixture and provenance raw manifest hashes differ"
);
assert(
  Object.values(rawHashes).every(isSha256),
  "raw manifest hash is invalid"
);
assert(
  rawHashes.mcpConfigSha256 === provenance.mcp.configSha256,
  "MCP configuration hash is not consistently bound"
);

const probe = provenance.capture.activityProbe;
assert(
  probe.paneTarget === readyBefore.paneTarget &&
    probe.paneId === readyBefore.paneId &&
    probe.activeClientsOnEverySelectedState === 0 &&
    probe.panePipeOnEverySelectedState === 0,
  "provenance pane binding differs from selected states"
);
assert(
  probe.ready.beforeState === readyBefore.state &&
    probe.ready.afterState === readyAfter.state &&
    probe.ready.windowActivityBefore === readyBefore.windowActivity &&
    probe.ready.windowActivityAfter === readyAfter.windowActivity &&
    probe.ready.cursorXBefore === readyBefore.cursor.x &&
    probe.ready.cursorXAfter === readyAfter.cursor.x &&
    JSON.stringify(probe.ready.orderedKeys) === JSON.stringify(["End", "C-l"]),
  "ready activity observations are not provenance-bound"
);
assert(
  probe.draft.sha256 === draftSha256 &&
    probe.draft.homeState === draftHome.state &&
    probe.draft.afterState === draftAfter.state &&
    probe.draft.restoredState === draftRestored.state &&
    probe.draft.clearedState === draftCleared.state &&
    probe.draft.windowActivityBefore === draftHome.windowActivity &&
    probe.draft.windowActivityAfter === draftAfter.windowActivity &&
    probe.draft.restoreActivityBefore === draftAfter.windowActivity &&
    probe.draft.restoreActivityAfter === draftRestored.windowActivity &&
    probe.draft.cursorXAtHome === draftHome.cursor.x &&
    probe.draft.cursorXAfterEnd === draftAfter.cursor.x &&
    probe.draft.cursorXAfterRestore === draftRestored.cursor.x &&
    probe.draft.cursorXAfterClear === draftCleared.cursor.x &&
    JSON.stringify(probe.draft.orderedProbeKeys) ===
      JSON.stringify(["End", "C-l"]) &&
    JSON.stringify(probe.draft.orderedRestoreKeys) ===
      JSON.stringify(["Home", "C-l"]),
  "draft activity observations are not provenance-bound"
);

console.log(
  "producer fixture replay metadata: PASS (9 states, detached, pane_pipe=0, activity advanced three times, draft preserved/restored/cleared)"
);
