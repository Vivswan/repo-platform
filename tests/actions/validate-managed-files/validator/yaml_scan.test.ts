import { describe, expect, test } from "bun:test";
import { tempDirs } from "../../../shared/temp_dir.ts";
import { validatorRunner } from "./fixtures";

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
      reason: "the registration",
      path: ".repo-platform.yml",
      content: "modules: [uv]\nmodules: [bun]\n",
      absent: "advisory",
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

describe("the walk honours the repository's .yamllint ignore list", () => {
  // yamllint skips what `ignore:` names, so a YAML-shaped file there (this repository's writer templates under files/,
  // with their {{placeholder}} tokens) is not YAML to the repository; the scan reading it anyway was 16 findings on a
  // clean tree. The matcher is a port of pathspec's GitIgnoreSpec, the library yamllint reads the list with (a fresh
  // install of the pinned yamllint resolves pathspec 1.1.1), so each row below was checked against that library; a
  // row's expectation is its answer.
  // One walk feeds every check, so the conflict-marker scan skips the same paths.
  const TEMPLATE =
    "ci:\n  uses: {{github_username}}/repo-platform/.github/workflows/fleet-ci.yml@stable\n";
  const BROKEN = "a: [1, 2\n";
  const CONFLICTED = `${"<".repeat(7)} ours\ntheirs\n${"=".repeat(7)}\n`;
  const ignore = (patterns: string) => `extends: default\n\nignore:\n${patterns}`;

  test.each<{ reason: string; tree: Record<string, string>; errors: string[] }>([
    {
      reason:
        "a bare directory name is skipped at any depth; the same file outside it is a finding",
      tree: {
        ".yamllint": ignore("  - files\n"),
        "files/base/ci.yml": TEMPLATE,
        "packages/a/files/ci.yml": TEMPLATE,
        "templates/ci.yml": TEMPLATE,
      },
      errors: ["templates/ci.yml"],
    },
    {
      reason: "a glob, an anchored path, a directory-only pattern, and the string form",
      tree: {
        ".yamllint": ignore(" |\n  *.generated.yml\n  /vendor/generated.yml\n  build/\n"),
        "deep/x.generated.yml": BROKEN,
        "vendor/generated.yml": BROKEN,
        "vendor/checked.yml": BROKEN,
        "other/vendor/generated.yml": BROKEN,
        "build/out.yml": BROKEN,
        "src/build": CONFLICTED,
      },
      errors: ["other/vendor/generated.yml", "src/build", "vendor/checked.yml"],
    },
    {
      reason: "a negation re-includes what an earlier pattern ignored",
      tree: {
        ".yamllint": ignore("  - fixtures\n  - '!fixtures/kept.yml'\n"),
        "fixtures/dropped.yml": BROKEN,
        "fixtures/kept.yml": BROKEN,
      },
      errors: ["fixtures/kept.yml"],
    },
    {
      reason: "the conflict-marker scan skips the ignored paths too",
      tree: {
        ".yamllint": ignore("  - .worktrees\n"),
        ".worktrees/agent/conflicted.md": CONFLICTED,
        ".worktrees/agent/broken.yml": BROKEN,
        "docs/conflicted.md": CONFLICTED,
        "release-please-config.json": `${CONFLICTED}{"release-as": "1.0.0"}\n`,
      },
      errors: ["docs/conflicted.md", "release-please-config.json"],
    },
    {
      reason:
        "an ignored release-please-config.json is outside every check, its release-as pin included",
      tree: {
        ".yamllint": ignore("  - '*.json'\n"),
        "release-please-config.json": '{"release-as": "1.0.0"}\n',
      },
      errors: [],
    },
    {
      reason:
        "pathspec's shapes: a directory pattern after **, literal braces, a kept leading and escaped trailing space",
      tree: {
        ".yamllint": ignore("  - a/**/\n  - '*.{md,txt}'\n  - ' spaced'\n  - 'tail\\ '\n"),
        "a/x.yml": BROKEN,
        "notes.md": CONFLICTED,
        "x.{md,txt}": CONFLICTED,
        " spaced/y.yml": BROKEN,
        "spaced/y.yml": BROKEN,
        "tail /z.yml": BROKEN,
        "tail/z.yml": BROKEN,
      },
      errors: ["notes.md", "spaced/y.yml", "tail/z.yml"],
    },
    {
      reason: "pathspec's precedence: a later directory match does not override a file negation",
      tree: {
        ".yamllint": ignore("  - foo/\n  - '!foo/bar.yml'\n  - foo/\n"),
        "foo/bar.yml": BROKEN,
        "foo/baz.yml": BROKEN,
      },
      errors: ["foo/bar.yml"],
    },
    {
      reason: "the list arrives through a merge key, as PyYAML reads it for yamllint",
      tree: {
        ".yamllint": "extends: default\n<<: {ignore: [files]}\n",
        "files/base/ci.yml": TEMPLATE,
      },
      errors: [],
    },
    {
      reason: "a .yamllint without an ignore list skips nothing",
      tree: {
        ".yamllint.yaml": "extends: default\n",
        "files/base/ci.yml": TEMPLATE,
        "node_modules/pkg/broken.yml": BROKEN,
      },
      errors: ["files/base/ci.yml", "node_modules/pkg/broken.yml"],
    },
    {
      reason:
        "a class that swallows the directory probe's slash prunes nothing; the files decide one by one",
      tree: {
        ".yamllint": ignore("  - a[!b]\n"),
        "a/broken.yml": BROKEN,
        "ac/broken.yml": BROKEN,
      },
      errors: ["a/broken.yml"],
    },
    {
      reason:
        "pathspec's classes: a literal ] leads a class, negated or not; an unclosed class discards its pattern",
      tree: {
        ".yamllint": ignore("  - '[!]]a.yml'\n  - '[]b]c.yml'\n  - '[abc.yml'\n  - files\n"),
        "]a.yml": BROKEN,
        "xa.yml": BROKEN,
        "]c.yml": BROKEN,
        "bc.yml": BROKEN,
        "[abc.yml": BROKEN,
        "files/base/ci.yml": TEMPLATE,
      },
      errors: ["[abc.yml", "]a.yml"],
    },
    {
      reason:
        "pathspec's units: a space is a segment character, not a separator; ? is one code point",
      tree: {
        ".yamllint": ignore("  - '/** *'\n  - '*.yml'\n  - '!?.yml'\n"),
        "a b.md": CONFLICTED,
        "ab.md": CONFLICTED,
        "sub/a b.md": CONFLICTED,
        "\u{1F600}.yml": BROKEN,
        "ab.yml": BROKEN,
      },
      errors: ["ab.md", "sub/a b.md", "\u{1F600}.yml"],
    },
  ])("$reason", ({ tree, errors }) => {
    const { exitCode, stderr } = runValidator(tree);
    expect([exitCode, erroring(stderr).sort()]).toEqual([errors.length === 0 ? 0 : 1, errors]);
  });

  test.each([
    { reason: "does not parse", config: "ignore: [files\n", message: "does not parse as YAML" },
    {
      reason: "carries a pattern yamllint refuses",
      config: "ignore:\n  - 'a\\'\n",
      message: "invalid ignore pattern",
    },
    {
      reason: "lists a non-string",
      config: "ignore:\n  - 1\n",
      message: "ignore should contain file patterns",
    },
    {
      reason: "sets ignore to a number",
      config: "ignore: 42\n",
      message: "ignore should contain file patterns",
    },
  ])("a .yamllint that $reason fails the run naming the file", ({ config, message }) => {
    const { exitCode, stderr } = runValidator({ ".yamllint": config });
    expect([exitCode === 0, stderr]).toEqual([
      false,
      expect.stringContaining(`.yamllint: ${message}`),
    ]);
  });
});
