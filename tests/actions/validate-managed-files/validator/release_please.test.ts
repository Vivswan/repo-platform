import { describe, expect, test } from "bun:test";
import { tempDirs } from "../../../shared/temp_dir.ts";
import { validatorRunner } from "./fixtures";

const temp = tempDirs();
const runValidator = validatorRunner(temp);

// release-please reads key PRESENCE: `release-as: null` and `release-as: ""` pin a version as surely as a
// number does, so a check that read the value would pass them.
describe("release-please-config.json never pins a version", () => {
  const config = (pkg: Record<string, unknown>, top: Record<string, unknown> = {}) =>
    JSON.stringify({ ...top, packages: { ".": { "release-type": "simple", ...pkg } } });
  // Every pin report carries the footer recipe; a parse failure has nothing to recommend yet.
  const PIN_REMEDY = [
    "release-please never removes the pin after that release ships, so the next release PR proposes the same version",
    "again (and force-tag-creation would move the published tag). Delete the key; to force a version once, merge an",
    'empty commit carrying a footer: git commit --allow-empty -m "chore: release 5.0.0" -m "Release-As: 5.0.0"',
  ].join(" ");
  const PACKAGE_PIN = `release-please-config.json pins a version with release-as at package ".": ${PIN_REMEDY}`;

  test.each([
    { reason: "no config file means nothing to check", file: undefined, stderr: "" },
    {
      reason: "a pin-free config passes",
      file: config({ "force-tag-creation": true }),
      stderr: "",
    },
    {
      reason: "a package-level release-as fails, naming the package and the footer",
      file: config({ "release-as": "4.0.0" }),
      stderr: PACKAGE_PIN,
    },
    {
      reason: "a top-level release-as fails too",
      file: config({}, { "release-as": "4.0.0" }),
      stderr: `release-please-config.json pins a version with release-as at the top level: ${PIN_REMEDY}`,
    },
    {
      reason: "a null value is still a pin",
      file: config({ "release-as": null }),
      stderr: PACKAGE_PIN,
    },
    {
      reason: "an empty string is still a pin",
      file: config({ "release-as": "" }),
      stderr: PACKAGE_PIN,
    },
    {
      reason: "a malformed config is an error, not a silent pass",
      file: "{ not json",
      stderr: "release-please-config.json: not valid JSON (JSON Parse error: Expected '}')",
    },
  ])("$reason", ({ file, stderr }) => {
    const r = runValidator(file === undefined ? {} : { "release-please-config.json": file });
    expect([r.exitCode, r.stderr]).toEqual(
      stderr === "" ? [0, ""] : [1, `error: ${stderr}\n\n1 error(s).\n`],
    );
  });
});
