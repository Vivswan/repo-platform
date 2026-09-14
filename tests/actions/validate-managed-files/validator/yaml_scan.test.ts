import { describe, expect, test } from "bun:test";
import { tempDirs } from "../../../shared/temp_dir.ts";
import { BASELINE, type RunValidatorOptions, validatorRunner } from "./fixtures";

const temp = tempDirs();
const runValidator = validatorRunner(temp);

const DUP_KEY_YAML = "homepage: https://a.example\nhomepage: https://b.example\n";

const erroring = (stderr: string): string[] =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith("error: "))
    .map((line) => line.slice("error: ".length).split(": ")[0]);

describe("duplicate mapping keys", () => {
  // parseAllDocuments composes a document with a duplicate key and reports DUPLICATE_KEY in doc.errors; the fleet's
  // readers parse with uniqueKeys off and keep the LAST value, so without this scan every consumer reads the wrong
  // one with no message.
  test.each([
    {
      reason: "settings.yml",
      path: ".github/settings.yml",
      content: DUP_KEY_YAML,
      absent: "advisory",
    },
    {
      reason: "a fixture outside .github/",
      path: "tests/fixtures/dup.yml",
      content: DUP_KEY_YAML,
      absent: "advisory",
    },
    {
      // The list is present, written twice: readers.ts parses with `uniqueKeys: false` so the registration
      // check does not add a second, wrong diagnostic.
      reason: "the registration, with no second wrong diagnostic",
      path: ".repo-platform.yml",
      content: "modules: [uv]\nmodules: [bun]\n",
      absent: "`modules` is missing",
    },
  ])(
    "a duplicate key anywhere fails with the tailored message: $reason",
    ({ path, content, absent }) => {
      const { exitCode, stdout, stderr } = runValidator({ [path]: content });
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`${path}: duplicate mapping key`);
      expect(stderr).toContain("the later value silently wins");
      expect(stdout + stderr).not.toContain(absent);
    },
  );
});

describe("YAML syntax errors", () => {
  // A directive with no document behind it composes ZERO documents and no stream error, so a scan over
  // per-document errors passes the file; the malformed and unsupported directives sit on the stream.
  test.each([
    {
      reason: "an unterminated flow sequence in a later document",
      content: "a: 1\n---\nb: [1, 2\n",
    },
    { reason: "a malformed directive with no document behind it", content: "%TAG\n" },
    {
      reason: "an unsupported YAML version directive with no document behind it",
      content: "%YAML nope\n",
    },
    { reason: "a valid version directive with no document behind it", content: "%YAML 1.2\n" },
    {
      reason: "a valid tag directive with no document behind it",
      content: "%TAG !e! tag:example.com,2026:\n",
    },
  ])("broken YAML anywhere fails: $reason", ({ content }) => {
    const { exitCode, stderr } = runValidator({ "config.yml": content });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("config.yml: does not parse as YAML");
  });

  test("a duplicate key cannot mask a resolution failure in the same file", () => {
    // doc.errors carries only composer-stage problems; the unresolved alias surfaces at conversion (doc.toJS).
    const { exitCode, stderr } = runValidator({
      "deploy/manifests.yml": "a: 1\na: 2\nb: *nope\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("deploy/manifests.yml: duplicate mapping key");
    expect(stderr).toContain("deploy/manifests.yml: does not parse as YAML");
  });
});

describe("multi-document YAML", () => {
  // Every parser accepts a stream; the consumers here read the first mapping and drop the rest silently.
  test.each<{ reason: string; content: string; errors: string[]; stderr: string }>([
    {
      reason: "a VALID two-document stream fails",
      content: "kind: Service\n---\nkind: Deployment\n",
      errors: ["deploy/manifests.yml"],
      stderr: "deploy/manifests.yml: multi-document YAML stream (2 documents)",
    },
    {
      reason: "an explicit document start is one document",
      content: "---\nkind: Service\n",
      errors: [],
      stderr: "",
    },
  ])("$reason", ({ content, errors, stderr }) => {
    const r = runValidator({ "deploy/manifests.yml": content });
    expect([r.exitCode, erroring(r.stderr)]).toEqual([errors.length === 0 ? 0 : 1, errors]);
    expect(r.stderr).toContain(stderr);
  });
});

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

describe("the walk under --self", () => {
  // The operator checkout carries gitignored working state (agent worktrees with in-progress rebases) that a
  // --self walk must not fail on; managed repositories are plain trees where everything is content. The skip
  // follows git's index, not the ignore patterns alone: a tracked file matching a pattern is still judged, which
  // a check-ignore walk would skip in the operator's own checkout.
  const IGNORED_TREE: Record<string, string> = {
    ".gitignore": `${BASELINE[".gitignore"]}.claude/worktrees/\n`,
    ".claude/worktrees/agent-x/broken.yml": "a: [1, 2\n",
    ".claude/worktrees/agent-x/conflicted.md": `${"<".repeat(7)} ours\ntheirs\n${"=".repeat(7)}\n`,
  };
  const SIBLINGS: Record<string, string> = {
    ".gitignore": `${BASELINE[".gitignore"]}vendor/generated.yml\n`,
    "vendor/generated.yml": "a: [1, 2\n",
    "vendor/checked.yml": "b: [1, 2\n",
  };

  test.each<{
    reason: string;
    tree: Record<string, string>;
    args: string[];
    opts: RunValidatorOptions;
    errors: string[];
  }>([
    {
      reason: "--self skips gitignored paths in a git checkout",
      tree: IGNORED_TREE,
      args: ["--self"],
      opts: { gitInit: true },
      errors: [],
    },
    {
      reason: "--self on a plain tree (no git) still scans everything",
      tree: IGNORED_TREE,
      args: ["--self"],
      opts: {},
      errors: [".claude/worktrees/agent-x/broken.yml", ".claude/worktrees/agent-x/conflicted.md"],
    },
    {
      reason: "a managed repository's walk ignores no paths even in a git checkout",
      tree: IGNORED_TREE,
      args: [],
      opts: { gitInit: true },
      errors: [".claude/worktrees/agent-x/broken.yml", ".claude/worktrees/agent-x/conflicted.md"],
    },
    {
      reason: "--self skips an ignored file while validating its siblings",
      tree: SIBLINGS,
      args: ["--self"],
      opts: { gitInit: true },
      errors: ["vendor/checked.yml"],
    },
    {
      reason: "--self still validates a tracked file matching an ignore pattern",
      tree: SIBLINGS,
      args: ["--self"],
      opts: { gitInit: true, gitAddForce: ["vendor/generated.yml"] },
      errors: ["vendor/checked.yml", "vendor/generated.yml"],
    },
  ])("$reason", ({ tree, args, opts, errors }) => {
    const { exitCode, stderr } = runValidator(tree, args, opts);
    expect([exitCode, erroring(stderr).sort()]).toEqual([errors.length === 0 ? 0 : 1, errors]);
  });
});
