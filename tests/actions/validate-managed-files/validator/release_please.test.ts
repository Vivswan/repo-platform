// release-please-config.json: a release-as pin at either level is an error
// naming the footer recipe; a malformed config never passes silently.

import { describe, expect, test } from "bun:test";
import { tempDirs } from "../../../shared/temp_dir.ts";
import { validatorRunner } from "./fixtures";

const temp = tempDirs();
const runValidator = validatorRunner(temp);

describe("release-please-config.json never pins a version", () => {
  const config = (pkg: Record<string, unknown>, top: Record<string, unknown> = {}) =>
    JSON.stringify({ ...top, packages: { ".": { "release-type": "simple", ...pkg } } });

  test.each([
    {
      reason: "a pin-free config passes",
      file: config({ "force-tag-creation": true }),
      exitCode: 0,
      stderr: "",
    },
    {
      reason: "a package-level release-as fails, naming the package and the footer",
      file: config({ "release-as": "4.0.0" }),
      exitCode: 1,
      stderr: 'release-please-config.json pins a version with release-as at package ".": ',
    },
    {
      reason: "a top-level release-as fails too",
      file: config({}, { "release-as": "4.0.0" }),
      exitCode: 1,
      stderr: "release-please-config.json pins a version with release-as at the top level: ",
    },
    {
      reason: "both spots are named at once",
      file: config({ "release-as": "4.0.0" }, { "release-as": "4.0.0" }),
      exitCode: 1,
      stderr: 'pins a version with release-as at the top level and package ".": ',
    },
    {
      reason: "a null value is still a pin (release-please reads key presence)",
      file: config({ "release-as": null }),
      exitCode: 1,
      stderr: 'release-please-config.json pins a version with release-as at package ".": ',
    },
    {
      reason: "an empty string is still a pin",
      file: config({ "release-as": "" }),
      exitCode: 1,
      stderr: 'release-please-config.json pins a version with release-as at package ".": ',
    },
    {
      reason: "a malformed config is an error, not a silent pass",
      file: "{ not json",
      exitCode: 1,
      stderr: "release-please-config.json: not valid JSON",
    },
  ])("$reason", ({ file, exitCode, stderr }) => {
    const r = runValidator({ "release-please-config.json": file });
    expect(r.exitCode).toBe(exitCode);
    if (stderr === "") expect(r.stderr).toBe("");
    else {
      expect(r.stderr).toContain(stderr);
      expect(r.stderr).toContain("1 error(s).");
      // Every pin report carries the footer recipe; a parse failure has
      // nothing to recommend yet.
      expect(r.stderr.includes('-m "Release-As: 5.0.0"')).toBe(stderr.includes("pins a version"));
    }
  });

  test("a conflict-marked config gets the conflict-marker check's report alone, not a JSON error on top", () => {
    const r = runValidator({
      "release-please-config.json": `<<<<<<< HEAD\n${config({})}\n=======\n${config({ "release-as": "4.0.0" })}\n>>>>>>> theirs\n`,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("release-please-config.json");
    expect(r.stderr).toContain("conflict");
    expect(r.stderr).not.toContain("not valid JSON");
    expect(r.stderr).not.toContain("pins a version");
  });

  test("a directory at the config path is left alone, not a crash", () => {
    const r = runValidator({ "release-please-config.json/keep": "" });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
  });

  test("self mode checks the config too", () => {
    const r = runValidator({ "release-please-config.json": config({ "release-as": "4.0.0" }) }, [
      "--self",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("pins a version with release-as at package");
  });

  test("no config file means nothing to check", () => {
    const r = runValidator();
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
  });
});
