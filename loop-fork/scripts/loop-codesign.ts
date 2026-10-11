/**
 * The code signature of a compiled `loop` for macOS.
 *
 * Bun ad-hoc signs a compiled binary as identifier `a.out`, with a new cdhash
 * every build. macOS privacy (TCC) grants follow the signature, so every new
 * build asked for Documents access again; under launchd that prompt parked
 * the orchestration server's mailbox read (the 2026-10-11 outage). A fixed
 * identifier, and with an owner's own code-signing identity
 * (LOOP_CODESIGN_IDENTITY) a stable designated requirement, keeps the grant.
 * Ad hoc (identity unset) the identifier is stable but the requirement is
 * still the cdhash, so a grant still does not survive a rebuild. See
 * docs/RUNBOOK-LOOP.md "Signing the loop binary".
 */
export const LOOP_CODESIGN_IDENTIFIER = "dev.harness.loop";

/**
 * The `codesign` arguments for `outfile`, or undefined when the binary is not
 * for macOS. An unset or blank identity signs ad hoc (`-`).
 */
export const loopCodesignArguments = (
  outfile: string,
  identity: string | undefined,
  targetPlatform: string
): string[] | undefined => {
  if (targetPlatform !== "darwin") {
    return undefined;
  }
  const signer = identity?.trim() ? identity.trim() : "-";
  return [
    "--force",
    "--sign",
    signer,
    "--identifier",
    LOOP_CODESIGN_IDENTIFIER,
    outfile,
  ];
};
