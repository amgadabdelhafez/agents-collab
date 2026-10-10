/**
 * A deliberately incompatible `temporalWorkflow`: it throws out of the
 * workflow task on every `append_record` command. The legacy journal replay
 * test bundles it as its control: replay of each recorded history with
 * completed workflow tasks must fail on it, which shows the replay reaches the
 * recorded signals and that a passing replay could have failed.
 */
import { condition, defineSignal, setHandler } from "@temporalio/workflow";

const commandSignal = defineSignal<[{ name?: string }]>(
  "workflow-port-command"
);

export async function temporalWorkflow(): Promise<never> {
  setHandler(commandSignal, (command) => {
    if (command.name === "append_record") {
      throw new Error("control bundle refuses append_record");
    }
  });
  await condition(() => false);
  throw new Error("unreachable");
}
