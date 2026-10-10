// Read-only: list the governess-beat executions in one Temporal namespace.
//
//   bun run scripts/governess-beat-list.ts --address 192.168.1.18:7233 \
//     --namespace harness [--task-queue loop-governess] [--all]
//
// Prints one JSON object per execution (src/loop/governess-beat-list.ts):
// id format, kind (v2, legacy-owned, legacy-unowned), owner repo from the
// memo, task queue, status and start time, then a summary line on stderr.
// Running executions only unless --all. It lists through visibility and
// never describes, signals, terminates or starts anything. It reads its
// target from flags, never from LOOP_GOVERNESS_TEMPORAL_*, so checking a
// namespace never turns the journal on in this shell.

import { parseArgs } from "node:util";
import { Connection, WorkflowClient } from "@temporalio/client";
import { listGovernessBeatExecutions } from "../src/loop/governess-beat-list";

const { values } = parseArgs({
  options: {
    address: { type: "string" },
    all: { default: false, type: "boolean" },
    namespace: { type: "string" },
    "task-queue": { type: "string" },
  },
});
if (!(values.address && values.namespace)) {
  console.error(
    "usage: governess-beat-list.ts --address <host:port> --namespace <ns> [--task-queue <q>] [--all]"
  );
  process.exit(2);
}
const connection = await Connection.connect({
  address: values.address,
  connectTimeout: 3000,
});
try {
  const listings = await listGovernessBeatExecutions(
    new WorkflowClient({ connection, namespace: values.namespace }),
    {
      includeClosed: values.all,
      ...(values["task-queue"] ? { taskQueue: values["task-queue"] } : {}),
    }
  );
  for (const listing of listings) {
    console.log(JSON.stringify(listing));
  }
  const byKind = new Map<string, number>();
  for (const listing of listings) {
    byKind.set(listing.kind, (byKind.get(listing.kind) ?? 0) + 1);
  }
  console.error(
    `governess-beat executions: ${listings.length} ${JSON.stringify(Object.fromEntries(byKind))}`
  );
} finally {
  await connection.close();
}
