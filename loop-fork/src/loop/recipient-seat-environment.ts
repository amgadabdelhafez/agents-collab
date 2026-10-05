import { resolve } from "node:path";

export const RECIPIENT_API_ENV_KEYS = [
  "LOOP_RECIPIENT_ENROLLMENT_RUN_DIR",
  "LOOP_CODEX_RECIPIENT_TOKEN",
  "LOOP_CLAUDE_RECIPIENT_TOKEN",
  "LOOP_RECIPIENT_RUN_DIR",
  "LOOP_RECIPIENT_SEAT",
  "LOOP_RECIPIENT_API_TOKEN",
  "LOOP_RECIPIENT_API_URL",
] as const;

/** Select one seat's token before provider spawn. All ambient enrollment and
 * foreign-seat tokens are removed, including for unrelated runs. */
export const recipientSeatEnvironment = (
  runDir: string,
  seat: string,
  input: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const env = { ...input };
  for (const key of RECIPIENT_API_ENV_KEYS) {
    delete env[key];
  }
  if (
    !input.LOOP_RECIPIENT_ENROLLMENT_RUN_DIR ||
    resolve(input.LOOP_RECIPIENT_ENROLLMENT_RUN_DIR) !== resolve(runDir)
  ) {
    return env;
  }
  if (seat !== "codex" && seat !== "claude") {
    return env;
  }
  const key =
    seat === "codex"
      ? "LOOP_CODEX_RECIPIENT_TOKEN"
      : "LOOP_CLAUDE_RECIPIENT_TOKEN";
  if (!(input[key] && input.LOOP_RECIPIENT_API_URL)) {
    throw new Error(
      "Recipient enrollment requires this seat's protected token and endpoint"
    );
  }
  return {
    ...env,
    LOOP_RECIPIENT_RUN_DIR: resolve(runDir),
    LOOP_RECIPIENT_SEAT: seat,
    LOOP_RECIPIENT_API_TOKEN: input[key],
    LOOP_RECIPIENT_API_URL: input.LOOP_RECIPIENT_API_URL,
  };
};
