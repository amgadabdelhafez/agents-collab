import { expect, test } from "bun:test";
import {
  ACTION_COMMS_UPSTREAM,
  ACTION_COMMS_UPSTREAM_SHA,
  ACTION_COMMS_UPSTREAM_URL,
  CAVEMAN_AUDIENCE_BOUNDARY,
  HUMAN_REPORTING_GUIDANCE,
  INTERNAL_AGENT_COMMUNICATION_GUIDANCE,
} from "../../src/loop/communication-guidance";

test("communication adaptation pins its reviewed upstream source", () => {
  expect(ACTION_COMMS_UPSTREAM).toBe("ayghri/i-have-adhd");
  expect(ACTION_COMMS_UPSTREAM_URL).toBe(
    "https://github.com/ayghri/i-have-adhd"
  );
  expect(ACTION_COMMS_UPSTREAM_SHA).toBe(
    "07684c4ab625dd7d1ea6e99e065f60bc0ac6a1ba"
  );
});

test("human reporting is action-first without delegating agent-owned work", () => {
  expect(HUMAN_REPORTING_GUIDANCE).toContain(
    "result, decision, blocker, or exact action required"
  );
  expect(HUMAN_REPORTING_GUIDANCE).toContain("Make state visible immediately");
  expect(HUMAN_REPORTING_GUIDANCE).toContain(
    "failed operation or location, cause, fix, and verification"
  );
  expect(HUMAN_REPORTING_GUIDANCE).toContain("at most one concrete action");
  expect(HUMAN_REPORTING_GUIDANCE).toContain("continue agent-owned work");
});

test("internal traffic stays evidence-dense under Caveman", () => {
  expect(INTERNAL_AGENT_COMMUNICATION_GUIDANCE).toContain(
    "No arbitrary item cap applies"
  );
  expect(INTERNAL_AGENT_COMMUNICATION_GUIDANCE).toContain(
    "purpose plus requested action or decision"
  );
  expect(INTERNAL_AGENT_COMMUNICATION_GUIDANCE).toContain("commands/results");
  expect(INTERNAL_AGENT_COMMUNICATION_GUIDANCE).toContain(
    "Separate observed facts from inference"
  );
  expect(INTERNAL_AGENT_COMMUNICATION_GUIDANCE).toContain(
    "Caveman may compress connective prose"
  );
  expect(CAVEMAN_AUDIENCE_BOUNDARY).toContain(
    "internal bridge, review, and handoff traffic evidence-dense"
  );
});
