import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../.github/scripts/sync/resolve_copier_conflicts.ts");

// Built by concatenation so this file never contains a literal marker line
// (the validator flags those in any text file).
const START = `${"<".repeat(7)} before updating`;
const SEP = "=".repeat(7);
const END = `${">".repeat(7)} after updating`;

const SENTINEL = "<!-- repo-platform:local-section -->";

function conflict(local: string[], template: string[]): string {
  return [START, ...local, SEP, ...template, END].join("\n");
}

function run(files: Record<string, string>, extraArgs: string[] = [], skipNames: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "resolve-copier-"));
  mkdirSync(join(root, "work"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, "work", name), content);
  }
  const summaryPath = join(root, "summary.md");
  const args = [...extraArgs];
  if (skipNames.length > 0) {
    const skipPath = join(root, "skip.txt");
    writeFileSync(skipPath, `${skipNames.join("\n")}\n`);
    args.push("--skip", skipPath);
  }
  const proc = Bun.spawnSync([
    "bun",
    script,
    "--summary",
    summaryPath,
    "--root",
    join(root, "work"),
    ...args,
  ]);
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    summary: readFileSync(summaryPath, "utf-8"),
    file: (name: string) => readFileSync(join(root, "work", name), "utf-8"),
  };
}

describe("resolve_copier_conflicts", () => {
  test("keeps the template side and drops local hunks to the summary", () => {
    const result = run({
      "README.md": `top\n${conflict(["local line"], ["template line"])}\nbottom\n`,
    });
    expect(result.exitCode).toBe(0);
    expect(result.file("README.md")).toBe("top\ntemplate line\nbottom\n");
    expect(result.stdout).toContain("README.md: resolved 1 conflict(s) toward the template");
    expect(result.summary).toContain("dropped local lines");
    expect(result.summary).toContain("local line");
  });

  test("a sentinel line in the kept side changes nothing: hunks still drop", () => {
    // Split-class files are rebuilt structurally BEFORE this pass
    // (preserve_local_content.ts --render-dir), so the resolver has no
    // sentinel special-casing left - a sentinel in the kept side is
    // ordinary content.
    const template = ["# Contributing", "", "Template body.", "", SENTINEL];
    const local = ["## Local setup", "", "run the thing"];
    const result = run({ "CONTRIBUTING.md": `${conflict(local, template)}\n` });
    expect(result.exitCode).toBe(0);
    expect(result.file("CONTRIBUTING.md")).toBe(`${template.join("\n")}\n`);
    expect(result.summary).toContain("dropped local lines");
    expect(result.summary).toContain("run the thing");
  });

  test("multiple conflicts in one file each land in the summary", () => {
    const content = [
      conflict(["first local"], ["kept one"]),
      conflict([], ["kept two"]),
      conflict(["second local"], ["kept three"]),
    ].join("\n");
    const result = run({ "SECURITY.md": `${content}\n` });
    expect(result.exitCode).toBe(0);
    expect(result.file("SECURITY.md")).toBe("kept one\nkept two\nkept three\n");
    expect(result.stdout).toContain("resolved 3 conflict(s) toward the template");
    expect(result.summary).toContain("first local");
    expect(result.summary).toContain("second local");
    expect(result.summary).toContain("(none; the local side of the conflict was empty)");
  });

  test("CRLF marker lines resolve and content keeps its bytes", () => {
    const content = `${conflict(["local tail"], ["Template body."])}\n`.replace(/\n/g, "\r\n");
    const result = run({ "CONTRIBUTING.md": content });
    expect(result.exitCode).toBe(0);
    expect(result.file("CONTRIBUTING.md")).toBe("Template body.\r\n");
  });

  test("files on the --skip list are left untouched, conflicts and all", () => {
    // The rebuilt split files: a carried repository half may legitimately
    // contain conflict-marker-shaped text, and this pass must not rewrite
    // what the rebuild just byte-preserved.
    const carried = `managed\n${SENTINEL}\ndocs quoting a conflict:\n${conflict(["local"], ["template"])}\n`;
    const result = run(
      {
        "AGENTS.md": carried,
        "README.md": `${conflict(["local line"], ["template line"])}\n`,
      },
      [],
      ["AGENTS.md"],
    );
    expect(result.exitCode).toBe(0);
    expect(result.file("AGENTS.md")).toBe(carried);
    expect(result.file("README.md")).toBe("template line\n");
    expect(result.summary).not.toContain("AGENTS.md");
  });

  test("leaves malformed marker files untouched", () => {
    const content = `top\n${START}\nlocal\n${END}\n`;
    const result = run({ "BROKEN.md": content });
    expect(result.exitCode).toBe(0);
    expect(result.file("BROKEN.md")).toBe(content);
    expect(result.summary).toContain("Malformed or out-of-order conflict markers");
  });

  test("marker bytes only mid-line are not a conflict and the file is skipped", () => {
    const content = `prose quoting ${START} mid-line\n`;
    const result = run({ "NOTES.md": content });
    expect(result.exitCode).toBe(0);
    expect(result.file("NOTES.md")).toBe(content);
    expect(result.summary).toBe("");
  });

  test("hide-details hides paths and content on stdout but keeps the summary intact", () => {
    const result = run(
      { "CONTRIBUTING.md": `${conflict(["secret local tail"], ["Template body."])}\n` },
      ["--hide-details", "true"],
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("CONTRIBUTING.md");
    expect(result.stdout).not.toContain("secret local tail");
    expect(result.stdout).toContain(
      "resolved 1 conflict(s) toward the template (path hidden: private repository)",
    );
    expect(result.summary).toContain("secret local tail");
    expect(result.summary).toContain("dropped local lines");
  });
});
