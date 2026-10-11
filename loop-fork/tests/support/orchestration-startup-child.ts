// Runs `runLoopOrchestrationServer` in its own process, as launchd runs
// `loop orchestration serve`, so a test can watch it from outside: a server
// whose event loop is frozen (the 2026-10-11 outage) cannot answer, and the
// test's own event loop keeps running to see that.
//
// argv: <configPath>. Test seams, all optional, from the environment:
// - LOOP_TEST_STARTUP_BOUNDS: JSON, the server's `startupBounds`.
// - LOOP_TEST_HUNG_MAILBOX: a path whose mailbox reads never return; each
//   entry appends one line to LOOP_TEST_HUNG_TRACE.
// - LOOP_TEST_PROBE_A2A_V2=ready: the start-time ledger probe answers.
import { appendFileSync } from "node:fs";
import { runLoopOrchestrationServer } from "../../src/loop/loop-orchestration-server";
import {
  type MailboxFileSystem,
  nodeMailboxFileSystem,
} from "../../src/loop/mailbox-file-access";

const configPath = process.argv[2];
if (!configPath) {
  throw new Error("usage: orchestration-startup-child.ts <configPath>");
}
const hung = process.env.LOOP_TEST_HUNG_MAILBOX;
const trace = process.env.LOOP_TEST_HUNG_TRACE;
const bounds = process.env.LOOP_TEST_STARTUP_BOUNDS;
const mailboxFileSystem: MailboxFileSystem | undefined = hung
  ? {
      ...nodeMailboxFileSystem,
      readFile: (path) => {
        if (path !== hung) {
          return nodeMailboxFileSystem.readFile(path);
        }
        if (trace) {
          appendFileSync(trace, "entered\n");
        }
        return new Promise<string>(() => undefined);
      },
    }
  : undefined;

console.error("[child] starting server");
await runLoopOrchestrationServer(configPath, process.env, {
  ...(bounds ? { startupBounds: JSON.parse(bounds) } : {}),
  ...(mailboxFileSystem ? { mailboxFileSystem } : {}),
  ...(process.env.LOOP_TEST_PROBE_A2A_V2 === "ready"
    ? { probeA2AV2Database: () => Promise.resolve(true) }
    : {}),
});
console.error("[child] server stopped");
// A read parked on a FIFO holds a worker thread; leave without waiting on it.
process.exit(0);
