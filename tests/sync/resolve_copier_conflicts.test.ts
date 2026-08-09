import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../.github/scripts/sync/resolve_copier_conflicts.ts");
const templatesDir = join(import.meta.dir, "..", "..", "templates");

// Built by concatenation so this file never contains a literal marker line
// (the validator flags those in any text file).
const START = `${"<".repeat(7)} before updating`;
const SEP = "=".repeat(7);
const END = `${">".repeat(7)} after updating`;

const SENTINEL = "<!-- repo-platform:local-section -->";
const HASH_SENTINEL = "# repo-platform:local-section";

const PROSE_MARKER = [
  "<!-- Repository-specific contributing documentation (dev setup, build and",
  "     test commands, review expectations) goes below this line. It survives",
  "     template updates via three-way merge. -->",
].join("\n");

function conflict(local: string[], template: string[]): string {
  return [START, ...local, SEP, ...template, END].join("\n");
}

function run(files: Record<string, string>, extraArgs: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "resolve-copier-"));
  mkdirSync(join(root, "work"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, "work", name), content);
  }
  const summaryPath = join(root, "summary.md");
  const proc = Bun.spawnSync([
    "bun",
    script,
    "--summary",
    summaryPath,
    "--root",
    join(root, "work"),
    ...extraArgs,
  ]);
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    summary: readFileSync(summaryPath, "utf-8"),
    file: (name: string) => readFileSync(join(root, "work", name), "utf-8"),
  };
}

describe("resolve_copier_conflicts", () => {
  test("keeps the template side and drops local hunks to the summary (no sentinel)", () => {
    const result = run({
      "README.md": `top\n${conflict(["local line"], ["template line"])}\nbottom\n`,
    });
    expect(result.exitCode).toBe(0);
    expect(result.file("README.md")).toBe("top\ntemplate line\nbottom\n");
    expect(result.stdout).toContain("README.md: resolved 1 conflict(s) toward the template");
    expect(result.stdout).not.toContain("below the repository-specific marker");
    expect(result.summary).toContain("dropped local lines");
    expect(result.summary).toContain("local line");
  });

  test("the prose marker alone (no sentinel line) does not trigger the move", () => {
    const template = ["Template body.", "", PROSE_MARKER];
    const result = run({ "CONTRIBUTING.md": `${conflict(["local guide"], template)}\n` });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("below the repository-specific marker");
    expect(result.summary).toContain("dropped local lines");
  });

  test("moves local hunks below the sentinel when the kept side carries it", () => {
    const template = ["# Contributing", "", "Template body.", "", PROSE_MARKER, SENTINEL];
    const local = ["# Contributing", "", "## Local setup", "", "run the thing"];
    const result = run({ "CONTRIBUTING.md": `${conflict(local, template)}\n` });
    expect(result.exitCode).toBe(0);
    const resolved = result.file("CONTRIBUTING.md");
    expect(resolved).toContain(SENTINEL);
    expect(resolved.indexOf("## Local setup")).toBeGreaterThan(resolved.indexOf(SENTINEL));
    expect(resolved.endsWith("run the thing\n")).toBe(true);
    expect(result.stdout).toContain("moved 1 local hunk(s) below the repository-specific marker");
    expect(result.summary).toContain("moved below the repository-specific marker");
    expect(result.summary).not.toContain("dropped local lines");
  });

  test("appends every non-empty hunk and keeps empty ones out of the file", () => {
    const template = ["Template body.", "", SENTINEL];
    const content = [
      conflict(["first local"], ["kept one"]),
      conflict([], ["kept two"]),
      conflict(["second local"], template),
    ].join("\n");
    const result = run({ "SECURITY.md": `${content}\n` });
    expect(result.exitCode).toBe(0);
    const resolved = result.file("SECURITY.md");
    expect(resolved).toContain("first local");
    expect(resolved).toContain("second local");
    expect(resolved.indexOf("first local")).toBeGreaterThan(resolved.indexOf(SENTINEL));
    expect(result.stdout).toContain("moved 2 local hunk(s)");
    expect(result.summary).toContain("(none; the local side of the conflict was empty)");
  });

  test("a sentinel only in the dropped local side does not trigger the move", () => {
    const local = ["local body", "", SENTINEL, "", "local tail"];
    const result = run({ "CONTRIBUTING.md": `${conflict(local, ["template body"])}\n` });
    expect(result.exitCode).toBe(0);
    expect(result.file("CONTRIBUTING.md")).toBe("template body\n");
    expect(result.stdout).not.toContain("below the repository-specific marker");
    expect(result.summary).toContain("dropped local lines");
  });

  test("a hunk carrying its own sentinel contributes only its tail, keeping one sentinel", () => {
    const template = ["New managed body.", "", SENTINEL];
    const local = ["Old managed body.", "", SENTINEL, "", "## Local guide", "", "local details"];
    const result = run({ "CONTRIBUTING.md": `${conflict(local, template)}\n` });
    expect(result.exitCode).toBe(0);
    const resolved = result.file("CONTRIBUTING.md");
    expect(resolved.split(SENTINEL).length - 1).toBe(1);
    expect(resolved).not.toContain("Old managed body.");
    expect(resolved).toContain("## Local guide");
    expect(resolved.endsWith("local details\n")).toBe(true);
    expect(result.summary).toContain(
      "the stale local copy of the managed half above it was dropped",
    );
  });

  test("a hunk that is only a stale managed half (nothing after its sentinel) is dropped", () => {
    const template = ["New managed body.", "", SENTINEL];
    const local = ["Old managed body.", "", SENTINEL];
    const result = run({ "SECURITY.md": `${conflict(local, template)}\n` });
    expect(result.exitCode).toBe(0);
    expect(result.file("SECURITY.md")).toBe(`New managed body.\n\n${SENTINEL}\n`);
    expect(result.stdout).not.toContain("moved");
    expect(result.summary).toContain("dropped local lines");
  });

  test("the hash-comment sentinel spelling moves hunks the same way", () => {
    const template = ["*.png binary", "", HASH_SENTINEL];
    const local = ["*.png binary", "", HASH_SENTINEL, "", "*.vsix binary"];
    const result = run({ ".gitattributes": `${conflict(local, template)}\n` });
    expect(result.exitCode).toBe(0);
    const resolved = result.file(".gitattributes");
    expect(resolved.split(HASH_SENTINEL).length - 1).toBe(1);
    expect(resolved.endsWith("*.vsix binary\n")).toBe(true);
    expect(result.stdout).toContain("moved 1 local hunk(s)");
  });

  test("handles a kept side without a trailing newline", () => {
    const template = ["Template body.", "", SENTINEL];
    const result = run({ "CONTRIBUTING.md": conflict(["local tail"], template) });
    expect(result.exitCode).toBe(0);
    expect(result.file("CONTRIBUTING.md")).toBe(`Template body.\n\n${SENTINEL}\n\nlocal tail\n`);
  });

  test("matches the file's CRLF line endings when appending", () => {
    const template = ["Template body.", "", SENTINEL];
    const content = `${conflict(["local tail"], template)}\n`.replace(/\n/g, "\r\n");
    const result = run({ "CONTRIBUTING.md": content });
    expect(result.exitCode).toBe(0);
    const resolved = result.file("CONTRIBUTING.md");
    expect(resolved).toContain(`${SENTINEL}\r\n\r\nlocal tail\r\n`);
    expect(resolved).not.toMatch(/[^\r]\n/);
  });

  test("leaves malformed marker files untouched", () => {
    const content = `top\n${START}\nlocal\n${END}\n`;
    const result = run({ "BROKEN.md": content });
    expect(result.exitCode).toBe(0);
    expect(result.file("BROKEN.md")).toBe(content);
    expect(result.summary).toContain("Malformed or out-of-order conflict markers");
  });

  test("one file with all three dispositions reports each heading truthfully", () => {
    const content = [
      conflict(["plain moved lines"], ["kept a"]),
      conflict(["stale half", SENTINEL, "tail after sentinel"], ["kept b"]),
      conflict(["stale half only", SENTINEL], ["kept c", "", SENTINEL]),
    ].join("\n");
    const result = run({ "CONTRIBUTING.md": `${content}\n` });
    expect(result.exitCode).toBe(0);
    const resolved = result.file("CONTRIBUTING.md");
    expect(resolved.split(SENTINEL).length - 1).toBe(1);
    expect(resolved).toContain("plain moved lines");
    expect(resolved).toContain("tail after sentinel");
    expect(resolved).not.toContain("stale half");
    expect(result.stdout).toContain("resolved 3 conflict(s) toward the template");
    expect(result.stdout).toContain("moved 2 local hunk(s)");
    expect(result.summary).toContain("local lines moved below the repository-specific marker");
    expect(result.summary).toContain(
      "the stale local copy of the managed half above it was dropped",
    );
    expect(result.summary).toContain("dropped local lines (template version kept)");
  });

  test("hide-details hides paths and content on stdout but keeps the summary intact", () => {
    const template = ["Template body.", "", SENTINEL];
    const result = run({ "CONTRIBUTING.md": `${conflict(["secret local tail"], template)}\n` }, [
      "--hide-details",
      "true",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("CONTRIBUTING.md");
    expect(result.stdout).not.toContain("secret local tail");
    expect(result.stdout).toContain(
      "resolved 1 conflict(s) toward the template; moved 1 local hunk(s) below the repository-specific marker (path hidden: private repository)",
    );
    expect(result.summary).toContain("secret local tail");
    expect(result.summary).toContain("moved below the repository-specific marker");
  });

  test("the templates with repository-owned tails end with the exact sentinel line", () => {
    const templated: [string, string][] = [
      [
        join(templatesDir, "base", "{% if not private %}CONTRIBUTING.md{% endif %}.jinja"),
        SENTINEL,
      ],
      [join(templatesDir, "base", "SECURITY.md.jinja"), SENTINEL],
      [
        join(
          templatesDir,
          "base",
          "{% if 'custom-license' not in modules %}LICENSE{% endif %}.jinja",
        ),
        SENTINEL,
      ],
      [join(templatesDir, "base", ".gitattributes.jinja"), HASH_SENTINEL],
      [join(templatesDir, "agents", "AGENTS.md.jinja"), SENTINEL],
    ];
    for (const [path, sentinel] of templated) {
      const lines = readFileSync(path, "utf-8").split("\n");
      const lastNonEmpty = lines.filter((line) => line.trim().length > 0).at(-1);
      // Last line, not just present: appendBelowSentinel writes at end of
      // file, so managed content below the sentinel would swallow moved hunks.
      expect(lastNonEmpty).toBe(sentinel);
    }
  });

  test("resolves real git merge-file output for the add/add prefix case without extra blanks", () => {
    // The litellm-vscode-chat #230 shape: local = render + local tail,
    // incoming = render, base = empty (file is new to the template). git's
    // zealous reduction factors out the shared prefix, so the conflict's
    // local side starts with the blank line that separated the tail.
    const render = `# Doc\n\nManaged body.\n\n${SENTINEL}\n`;
    const tail = "## Local setup\n\nrun the thing\n";
    const root = mkdtempSync(join(tmpdir(), "resolve-copier-merge-"));
    const localPath = join(root, "local.md");
    const basePath = join(root, "base.md");
    const remotePath = join(root, "remote.md");
    writeFileSync(localPath, `${render}\n${tail}`);
    writeFileSync(basePath, "");
    writeFileSync(remotePath, render);
    const merge = Bun.spawnSync([
      "git",
      "merge-file",
      "-L",
      "before updating",
      "-L",
      "base",
      "-L",
      "after updating",
      localPath,
      basePath,
      remotePath,
    ]);
    expect(merge.exitCode).toBeGreaterThan(0);
    const result = run({ "CONTRIBUTING.md": readFileSync(localPath, "utf-8") });
    expect(result.exitCode).toBe(0);
    expect(result.file("CONTRIBUTING.md")).toBe(`${render}\n${tail}`);
  });
});
