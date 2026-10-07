/**
 * A deliberately incompatible `temporalWorkflow`: it fails the workflow task
 * on the last command each recorded history holds (as a build that refuses a
 * recorded signal would). The replay test bundles it as its control: replay
 * must fail every history that has a command, which shows the replay reaches
 * each history's last signal and that a passing replay could have failed.
 */
import { condition, defineSignal, setHandler } from "@temporalio/workflow";
import { replayScenarios } from "../../support/temporal-replay-scenarios";

const lastCommands = new Set(
  replayScenarios({
    label: "control",
    messageWorkflowId: (dedupeKey) => dedupeKey,
    parseMessageInput: (input) => input,
    resultGraphWorkflowId: (messageWorkflowId) => messageWorkflowId,
  }).flatMap((scenario) =>
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
