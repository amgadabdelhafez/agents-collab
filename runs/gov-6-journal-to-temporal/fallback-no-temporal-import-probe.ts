import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import * as net from "node:net";
let dials = 0; const orig = net.Socket.prototype.connect; (net.Socket.prototype as any).connect = function (...a: any[]) { dials++; return (orig as any).apply(this, a); };
const { attachGovernessJournalBackend, governessTemporalConfigFromEnv } = await import("../../loop-fork/src/loop/governess-temporal-journal");
const { recordGovernessObservation, readGovernessJournal } = await import("../../loop-fork/src/loop/governess-journal");
const loaded = () => Object.keys(require.cache).filter((k) => k.includes("@temporalio")).length;
const file = join(mkdtempSync(join(tmpdir(), "gov6-probe-")), "journal.jsonl");
const backend = await attachGovernessJournalBackend({ journalFile: file, runId: "probe", temporal: governessTemporalConfigFromEnv({}) });
console.log("kind", backend.kind, "temporalioModulesLoaded", loaded(), "socketDials", dials);
if (process.argv[2] === "control") { await import("@temporalio/client"); console.log("control temporalioModulesLoaded", loaded()); }
