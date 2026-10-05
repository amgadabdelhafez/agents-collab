import type { AgentCard } from "@a2a-js/sdk";
import type { A2ARequestHandler, AgentExecutor } from "@a2a-js/sdk/server";
import { agentCardFor } from "./a2a-supervisor-adapter";
import type { SupervisorA2AExecutor } from "./a2a-supervisor-executor";
import type { SupervisorA2ARequestHandler } from "./a2a-supervisor-request-handler";

/**
 * Compile-time conformance to the A2A SDK, asserted rather than assumed.
 *
 * Why this file exists: `bun run check` is Biome, which does not typecheck, and
 * a repo-wide `tsc` currently reports 279 pre-existing errors across 70 files.
 * So nothing was enforcing the claim that these modules match the protocol's
 * own types — I had verified it by hand and then written it down as though a
 * compiler guaranteed it. `bun run typecheck:a2a` makes it a check that runs.
 *
 * The instrument was validated before being trusted: with a deliberately wrong
 * type in place of the executor, tsc reports "missing the following properties
 * from type 'AgentExecutor': execute, cancelTask", and with a required field
 * removed from the card it reports "Property 'signatures' is missing". A clean
 * result here therefore means conformance, not a check that silently passed.
 */

/** The executor is what the SDK's server will actually accept. */
export type ExecutorIsAnAgentExecutor =
  SupervisorA2AExecutor extends AgentExecutor ? true : never;
export const executorConforms: ExecutorIsAnAgentExecutor = true;

/** The prevalidation boundary remains a drop-in SDK request handler. */
export type HandlerIsAnA2ARequestHandler =
  SupervisorA2ARequestHandler extends A2ARequestHandler ? true : never;
export const handlerConforms: HandlerIsAnA2ARequestHandler = true;

/** The card builder really produces a complete AgentCard. */
export const cardConforms: AgentCard = agentCardFor({
  description: "Conformance sample, not a live identity.",
  supervisorId: "supervisor:conformance",
  url: "http://127.0.0.1:0/a2a",
});
