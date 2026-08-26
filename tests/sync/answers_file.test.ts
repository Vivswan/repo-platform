import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnswersFileError, readAnswersFile } from "../../.github/scripts/sync/answers_file.ts";

function read(content: string) {
  const path = join(mkdtempSync(join(tmpdir(), "answers-file-")), "answers.yml");
  writeFileSync(path, content);
  return readAnswersFile(path);
}

describe("readAnswersFile", () => {
  test("parses commit and keeps every field for other consumers", () => {
    const answers = read("_commit: abc1234\nprivate: true\n");
    expect(answers.commit).toBe("abc1234");
    expect(answers.fields.private).toBe(true);
  });

  test("undoes copier's to_nice_yaml quoting of a digit-only short sha", () => {
    expect(read("_commit: '1234567'\n").commit).toBe("1234567");
    expect(read("_commit: 1234567\n").commit).toBe("1234567");
  });

  test("bare short shas that are YAML 1.2 numbers come back verbatim", () => {
    // PyYAML (copier's writer) leaves these bare; the default YAML 1.2
    // schema would read them as numbers ("89012", "1.626e+56", "Infinity",
    // "0") and the sync would resolve or reject a value that appears
    // nowhere in the file.
    for (const sha of ["0089012", "1626e53", "791e558", "0e50454"]) {
      expect(read(`_commit: ${sha}\n`).commit).toBe(sha);
    }
  });

  test("an absent or non-scalar _commit is empty (the caller fails it loudly)", () => {
    expect(read("private: true\n").commit).toBe("");
    expect(read("_commit: [a, b]\n").commit).toBe("");
  });

  test("a non-mapping top level throws AnswersFileError", () => {
    expect(() => read("- just\n- a\n- list\n")).toThrow(AnswersFileError);
    expect(() => read("")).toThrow("top level must be a mapping");
  });

  test("unparseable YAML throws AnswersFileError naming the parse failure", () => {
    expect(() => read("a: [\n")).toThrow(AnswersFileError);
    expect(() => read("a: [\n")).toThrow("cannot read as YAML");
  });
});
