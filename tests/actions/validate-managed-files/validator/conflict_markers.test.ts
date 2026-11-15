import { describe, expect, test } from "bun:test";
import { tempDirs } from "../../../shared/temp_dir.ts";
import { validatorRunner } from "./fixtures";

const temp = tempDirs();
const runValidator = validatorRunner(temp);

const OURS = `${"<".repeat(7)} HEAD`;
const SPLIT = "=".repeat(7);
const THEIRS = `${">".repeat(7)} topic`;
const BLOCK = [OURS, "ours", SPLIT, "theirs", THEIRS, ""].join("\n");

const REPORT =
  "carries conflict-marker lines (a line opening with '<<<<<<< ' or '>>>>>>> ', or reading '=======' whole) - " +
  "resolve each conflict block, or move an example so no line reads as a marker";

describe("conflict markers", () => {
  // Incident: an unresolved block in `tool.mts` and `lib.rs` passed, since a suffix table decided what was text.
  // What git reads as text is judged whatever its name; what git does not track, or reads as binary, is not.
  test("every tracked text file carrying a marker line is reported, and nothing else is", () => {
    const { exitCode, stderr } = runValidator(
      {
        "src/tool.mts": BLOCK,
        "src/lib.rs": BLOCK,
        // The check reads lines, not intent: a fenced example is reported like a real block.
        "docs/notes.md": ["```text", OURS, SPLIT, THEIRS, "```", ""].join("\n"),
        // The equals line is matched whole, so it alone can hide behind a carriage return.
        "docs/crlf.txt": `${SPLIT}\r\n`,
        // A setext heading's underline of any length but seven is no marker.
        "docs/guide.md": ["Guide", "=".repeat(5), "", "Overview", "=".repeat(8), ""].join("\n"),
        "docs/prose.md": `a diff shows ${OURS} mid-line, and ${SPLIT} too\n`,
        "assets/blob.bin": `\x00\x01\n${BLOCK}`,
      },
      { "build/merged.txt": BLOCK },
    );

    expect([exitCode, stderr.split("\n").filter((line) => line.startsWith("error:"))]).toEqual([
      1,
      ["docs/crlf.txt", "docs/notes.md", "src/lib.rs", "src/tool.mts"].map(
        (path) => `error: ${path}: ${REPORT}`,
      ),
    ]);
  });
});
