import { describe, expect, test } from "bun:test";
import { tempDirs } from "../../../shared/temp_dir.ts";
import { validatorRunner } from "./fixtures";

const temp = tempDirs();
const runValidator = validatorRunner(temp);

describe("conflict markers", () => {
  // The motivating input: a synced Markdown doc quoting the markers inside a fence. The check reads lines, not
  // intent, so the message names what stands in the file and never who left it.
  // The angle markers are matched by prefix and the equals line whole, so only the equals line can hide behind a
  // carriage return: the CRLF case carries it alone.
  test.each([
    {
      ending: "LF",
      newline: "\n",
      markers: [`${"<".repeat(7)} ours`, "theirs", "=".repeat(7), `${">".repeat(7)} theirs`],
    },
    { ending: "CRLF", newline: "\r\n", markers: ["=".repeat(7)] },
  ])(
    "a fenced conflict-marker example ($ending) is reported by what the file carries; binary content is skipped",
    ({ newline, markers }) => {
      const { exitCode, stderr } = runValidator({
        "docs/notes.md": ["```text", ...markers, "```", ""].join(newline),
        "assets/blob.bin": "\xff\xfe\x00\x01",
      });
      expect(exitCode).toBe(1);
      expect(stderr.split("\n").filter((line) => line.startsWith("error:"))).toEqual([
        "error: docs/notes.md: carries conflict-marker lines (a line opening with '<<<<<<< ' or '>>>>>>> ', " +
          "or reading '=======' whole) - resolve each conflict block, or move an example so no line reads as a marker",
      ]);
    },
  );
});
