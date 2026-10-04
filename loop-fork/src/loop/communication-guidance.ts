export const ACTION_COMMS_UPSTREAM = "ayghri/i-have-adhd";
export const ACTION_COMMS_UPSTREAM_URL =
  "https://github.com/ayghri/i-have-adhd";
export const ACTION_COMMS_UPSTREAM_SHA =
  "07684c4ab625dd7d1ea6e99e065f60bc0ac6a1ba";

export const HUMAN_REPORTING_GUIDANCE = [
  "Human/founder/supervisor reporting:",
  "- First line: result, decision, blocker, or exact action required—not tool narration, history, or an investigation plan.",
  "- Make state visible immediately (done, blocked, or decision needed), then give the smallest supporting evidence.",
  "- Errors: failed operation or location, cause, fix, and verification. No emotional filler.",
  "- Ask for at most one concrete action only when blocked; otherwise continue agent-owned work. Keep lists short and ranked, without dropping safety or requested explanation.",
].join("\n");

export const INTERNAL_AGENT_COMMUNICATION_GUIDANCE = [
  "Internal agent communication:",
  "- Machine-reviewed: evidence density wins. No arbitrary item cap applies.",
  "- First: purpose plus requested action or decision. Then exact scope/locations, claims, commands/results, changed assumptions, risks, unknowns, and relevant failed paths.",
  "- Separate observed facts from inference. End with the exact question, decision, review, or next action requested.",
  "- Caveman may compress connective prose, never exact paths, errors, SHAs, identifiers, citations, review reasoning, or verification evidence.",
].join("\n");

export const CAVEMAN_AUDIENCE_BOUNDARY =
  "Keep human/founder/supervisor reports action-first. Keep internal bridge, review, and handoff traffic evidence-dense; never trade review evidence for brevity.";

export const DRIVER_CHECK_IN_GUIDANCE = [
  "Driver check-ins:",
  "- Send the reviewer a short check-in before each subtask: a three-line approach plus the riskiest assumption; at every commit: SHA, diffstat, and the decision most likely to be wrong; and whenever about ten minutes have passed without a check-in.",
  "- Check-ins are nonblocking: send, keep working, and apply the reviewer's reply when it arrives. Blocking review happens only at the final gate or on a real STOP; check-ins are not plan-stage approval gates.",
].join("\n");

export const REVIEWER_CHECK_IN_GUIDANCE = [
  "Reviewer check-in replies:",
  "- Reply briefly to each driver check-in with defects that would change code, a number, or a claim; say what you did not inspect.",
  "- Check-ins are nonblocking; the driver keeps working and applies replies. Blocking review happens only at the final gate or on a real STOP; do not turn check-ins into plan-stage approval gates.",
].join("\n");
