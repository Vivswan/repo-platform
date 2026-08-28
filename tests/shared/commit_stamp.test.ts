import { describe, expect, test } from "bun:test";
import {
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
      "build(template): main from 62653b669d40",
      "",
      "source: https://github.com/Vivswan/repo-platform/commit/62653b669d40d3c88b6a0c713942d7e80ac4032d",
      "run: https://github.com/Vivswan/repo-platform/actions/runs/1",
    ].join("\n");
    expect(commitStampParse(message)).toBe("62653b669d40d3c88b6a0c713942d7e80ac4032d");
  });

  test("parse prints nothing for a message without a stamp", () => {
    expect(commitStampParse("chore: no stamp here")).toBe("");
  });

  test("the run line is write-only: a breadcrumb, never parsed as the stamp", () => {
    // The retired run-proof check was the run line's last reader; the
    // writer stays so humans can jump from a build commit to the run
    // that pushed it, and the stamp parser must never mistake it for a
    // source line.
    const line = commitRunWrite("https://github.com/Vivswan/repo-platform/actions/runs/8675309");
    expect(line).toBe("run: https://github.com/Vivswan/repo-platform/actions/runs/8675309");
    expect(commitStampParse(line)).toBe("");
  });
});
