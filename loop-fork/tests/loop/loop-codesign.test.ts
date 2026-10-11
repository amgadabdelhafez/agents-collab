import { expect, test } from "bun:test";
import {
  LOOP_CODESIGN_IDENTIFIER,
  loopCodesignArguments,
} from "../../scripts/loop-codesign";

// Every ad-hoc-signed build was identifier `a.out` with a new cdhash, so
// macOS raised its Documents privacy prompt again for each one (the
// 2026-10-11 outage). A stable identifier, and with an owner's code-signing
// identity a stable designated requirement, keeps the grant across builds.

test("unset identity: ad-hoc signed under the stable identifier", () => {
  expect(LOOP_CODESIGN_IDENTIFIER).toBe("dev.harness.loop");
  expect(loopCodesignArguments("/out/loop", undefined, "darwin")).toEqual([
    "--force",
    "--sign",
    "-",
    "--identifier",
    "dev.harness.loop",
    "/out/loop",
  ]);
  expect(loopCodesignArguments("/out/loop", "  ", "darwin")).toEqual([
    "--force",
    "--sign",
    "-",
    "--identifier",
    "dev.harness.loop",
    "/out/loop",
  ]);
});

test("LOOP_CODESIGN_IDENTITY: signed with that identity under the same identifier", () => {
  expect(
    loopCodesignArguments("/out/loop", "loop local signing", "darwin")
  ).toEqual([
    "--force",
    "--sign",
    "loop local signing",
    "--identifier",
    "dev.harness.loop",
    "/out/loop",
  ]);
});

test("a binary for another platform is not signed", () => {
  expect(
    loopCodesignArguments("/out/loop", undefined, "linux")
  ).toBeUndefined();
});
