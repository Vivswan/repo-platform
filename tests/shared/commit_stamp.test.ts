import { describe, expect, test } from "bun:test";
import {
  commitRunParse,
  commitRunWrite,
  commitStampParse,
  commitStampWrite,
} from "../../.github/scripts/shared/commit_stamp.ts";

describe("commit stamp", () => {
  test("write then parse round-trips the sha", () => {
    const sha = "62653b669d40d3c88b6a0c713942d7e80ac4032d";
    const line = commitStampWrite("https://github.com", "Vivswan/repo-platform", sha);
    expect(commitStampParse(line)).toBe(sha);
  });

  test("parse finds the stamp inside a full build commit message", () => {
    const message = [
      "build(staging): main from 62653b669d40",
      "",
      "source: https://github.com/Vivswan/repo-platform/commit/62653b669d40d3c88b6a0c713942d7e80ac4032d",
      "run: https://github.com/Vivswan/repo-platform/actions/runs/1",
    ].join("\n");
    expect(commitStampParse(message)).toBe("62653b669d40d3c88b6a0c713942d7e80ac4032d");
  });

  test("parse prints nothing for a message without a stamp", () => {
    expect(commitStampParse("chore: no stamp here")).toBe("");
  });
});

describe("run line", () => {
  test("write then parse round-trips the run id", () => {
    const line = commitRunWrite("https://github.com/Vivswan/repo-platform/actions/runs/8675309");
    expect(commitRunParse(line)).toBe("8675309");
  });

  test("parse yields only numeric run ids", () => {
    // The line is plain text anyone can write; a smuggled non-numeric id
    // must parse as "no run line", never reach an API path.
    expect(commitRunParse("run: https://github.com/o/r/actions/runs/../secrets")).toBe("");
    expect(commitRunParse("run: https://github.com/o/r/actions/runs/12/attempts/3")).toBe("");
    expect(commitRunParse("run: https://github.com/o/r/actions/runs/")).toBe("");
  });

  test("parse prints nothing for a message without a run line", () => {
    expect(commitRunParse("chore: no run here")).toBe("");
  });
});
