import { describe, expect, test } from "bun:test";
import { tempDirs } from "../../../shared/temp_dir.ts";
import { BASELINE, validatorRunner } from "./fixtures";

const temp = tempDirs();
const runValidator = validatorRunner(temp);

const DUP_KEY_YAML = "homepage: https://a.example\nhomepage: https://b.example\n";

describe("duplicate mapping keys", () => {
  // Strictness follows the .github/ prefix (plus the registration file):
  // GitHub's own parsers reject duplicate keys in a workflow anyway, and a
  // merge can duplicate settings.yml's identity keys, where the later value
  // silently wins at apply time.
  test.each([
    { reason: "settings.yml", path: ".github/settings.yml", content: DUP_KEY_YAML },
    {
      reason: "a repo-owned workflow, checks.yml",
      path: ".github/workflows/checks.yml",
      content: "name: Checks\nname: Checks again\non: [push]\n",
    },
    {
      reason: "a document of a multi-document stream (itself a second error there)",
      path: ".github/multi.yml",
      content: "a: 1\na: 2\n---\nb: 3\n",
    },
  ])(
    "a duplicate key under .github/ fails with the tailored message: $reason",
    ({ path, content }) => {
      const { exitCode, stderr } = runValidator({ [path]: content });
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`${path}: duplicate mapping key`);
      expect(stderr).toContain("the later value silently wins");
    },
  );

  test("a duplicate key in the registration fails, and not a second wrong diagnostic", () => {
    const { exitCode, stderr } = runValidator({
      ".repo-platform.yml": "modules: [uv]\nmodules: [bun]\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".repo-platform.yml: duplicate mapping key");
    // The list is present, it is just written twice.
    expect(stderr).not.toContain("`modules` is missing");
  });

  test.each([
    { reason: "a single-document fixture", path: "tests/fixtures/dup.yml", content: DUP_KEY_YAML },
    {
      reason: "a multi-document file",
      path: "deploy/manifests.yml",
      content: "a: 1\na: 2\n---\nb: 3\n",
    },
  ])(
    "a duplicate key outside the strict set is an advisory, not an error: $reason",
    ({ path, content }) => {
      const { exitCode, stdout, stderr } = runValidator({ [path]: content });
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toContain(`advisory: ${path}: duplicate mapping key`);
    },
  );
});

describe("YAML syntax errors", () => {
  // Outside the strict set a duplicate key is only an advisory, so the masking row pins that it cannot hide a syntax error in the same document.
  test.each([
    {
      reason: "an unterminated flow sequence in the first document",
      path: "vendor/bad.yml",
      content: "a: [1, 2\n",
    },
    {
      reason: "an unterminated flow sequence in a later document",
      path: "deploy/manifests.yml",
      content: "a: 1\n---\nb: [1, 2\n",
    },
    {
      reason: "a duplicate key cannot mask a syntax error",
      path: "tests/fixtures/broken.yml",
      content: "a: 1\na: 2\nb: [unclosed\n",
    },
  ])("broken YAML anywhere fails: $reason", ({ path, content }) => {
    const { exitCode, stderr } = runValidator({ [path]: content });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`${path}: does not parse as YAML`);
  });

  test("a duplicate key cannot mask a resolution failure in the same file", () => {
    // doc.errors carries only composer-stage problems; the unresolved
    // alias surfaces at conversion (doc.toJS) and must still fail even
    // though the duplicate key already reported (as an advisory here).
    const { exitCode, stderr } = runValidator({
      "deploy/manifests.yml": "a: 1\na: 2\nb: *nope\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("deploy/manifests.yml: does not parse as YAML");
  });
});

describe("multi-document YAML", () => {
  test("a valid multi-document file passes", () => {
    const { exitCode, stderr } = runValidator({
      "deploy/manifests.yml": "kind: Service\n---\nkind: Deployment\n",
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("a VALID multi-document .github/ file still fails - GitHub reads one mapping", () => {
    const { exitCode, stderr } = runValidator({
      ".github/dependabot.yml": "version: 2\nupdates: []\n---\nversion: 2\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".github/dependabot.yml: multi-document YAML stream");
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

describe("gitignored paths in self mode", () => {
  // The operator checkout carries gitignored working state (agent
  // worktrees with in-progress rebases) that a --self walk must not fail
  // on; managed repositories are plain trees where everything is content.
  const IGNORED_TREE: Record<string, string> = {
    ".gitignore": `${BASELINE[".gitignore"]}.claude/worktrees/\n`,
    ".claude/worktrees/agent-x/broken.yml": "a: [1, 2\n",
    ".claude/worktrees/agent-x/conflicted.md": `${"<".repeat(7)} ours\ntheirs\n${"=".repeat(7)}\n`,
  };

  test("--self skips gitignored paths in a git checkout", () => {
    const { exitCode, stderr } = runValidator(IGNORED_TREE, ["--self"], { gitInit: true });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("--self on a plain tree (no git) still scans everything", () => {
    const { exitCode, stderr } = runValidator(IGNORED_TREE, ["--self"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".claude/worktrees/agent-x/broken.yml: does not parse as YAML");
  });

  test("a managed repository's walk ignores no paths even in a git checkout", () => {
    const { exitCode, stderr } = runValidator(IGNORED_TREE, [], { gitInit: true });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".claude/worktrees/agent-x/broken.yml: does not parse as YAML");
    expect(stderr).toContain("conflicted.md: carries conflict-marker lines");
  });

  test("--self skips an ignored file while validating its siblings in the same directory", () => {
    const { exitCode, stderr } = runValidator(
      {
        ".gitignore": `${BASELINE[".gitignore"]}vendor/generated.yml\n`,
        "vendor/generated.yml": "a: [1, 2\n",
        "vendor/checked.yml": "b: [1, 2\n",
      },
      ["--self"],
      { gitInit: true },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("vendor/checked.yml: does not parse as YAML");
    expect(stderr).not.toContain("vendor/generated.yml");
  });

  test("--self still validates a tracked file matching an ignore pattern", () => {
    const { exitCode, stderr } = runValidator(
      {
        ".gitignore": `${BASELINE[".gitignore"]}vendor/generated.yml\n`,
        "vendor/generated.yml": "a: [1, 2\n",
      },
      ["--self"],
      { gitInit: true, gitAddForce: ["vendor/generated.yml"] },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("vendor/generated.yml: does not parse as YAML");
  });

  test("--self leaves the writer's sources alone: files/ carries placeholders, not YAML", () => {
    const { exitCode, stderr } = runValidator(
      { "files/base/.github/dependabot.yml": "version: 2\nupdates:\n{{blocks}}\n" },
      ["--self"],
    );
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });
});
