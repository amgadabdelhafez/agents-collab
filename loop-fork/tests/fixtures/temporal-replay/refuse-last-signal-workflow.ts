/**
 * A deliberately incompatible `temporalWorkflow`: its signal handler throws
 * out of the workflow task on the last command each recorded history holds.
 * The replay test bundles it as its control: replay must fail every history
 * that has a command, which shows the replay reaches each history's last
 * signal and that a passing replay could have failed.
 *
 * This is not what a build that refuses a recorded signal does. The real
 * `temporalWorkflow` (src/loop/temporal-workflow.ts, `applyCommand`) catches
 * any error the workflow definition throws while applying a signal and
 * records it as that command's error outcome, so the workflow task succeeds
 * and the history still replays; only the state and the command outcome
 * differ, which the live handoffs check (runbook, "In-flight Temporal
 * executions across a bundle change", corrected 2026-10-09).
 */
import { condition, defineSignal, setHandler } from "@temporalio/workflow";
import {
  deployedReplayScenarios,
  replayScenarios,
} from "../../support/temporal-replay-scenarios";

const lastCommands = new Set(
  [
    ...replayScenarios({
      label: "control",
      messageWorkflowId: (dedupeKey) => dedupeKey,
      parseMessageInput: (input) => input,
      resultGraphWorkflowId: (messageWorkflowId) => messageWorkflowId,
    }),
    ...deployedReplayScenarios({
      label: "control",
      v1MessageWorkflowId: (dedupeKey) => dedupeKey,
    }),
  ].flatMap((scenario) =>
    scenario.before.slice(-1).map((command) => command.requestId)
  )
);

const commandSignal = defineSignal<[{ requestId: string }]>(
  "workflow-port-command"
);

export async function temporalWorkflow(): Promise<never> {
  setHandler(commandSignal, (command) => {
    if (lastCommands.has(command.requestId)) {
      throw new Error(`this build refuses ${command.requestId}`);
    }
  });
  await condition(() => false);
  throw new Error("unreachable");
}
