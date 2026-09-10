// The check evaluator (checks.ts): every check kind shown green on a
// fixture that satisfies it and red on one that does not, so a kind that
// silently passes cannot hide behind a green expectation table.

import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../shared/temp_dir";
import { matchesPartial, runChecks, valueAt } from "./checks.ts";
import { type Check, includes } from "./expectations.ts";

const temp = tempDirs();

const WORKFLOW = [
  "# a comment naming cancelled() must never count",
  "name: CI",
  "on:",
  "  workflow_dispatch:",
  "  schedule:",
  '    - cron: "3 8 * * 1"',
  "permissions:",
  "  contents: read",
  "jobs:",
  "  ci:",
  "    uses: Vivswan/repo-platform/.github/workflows/fleet-ci.yml@build",
  "    with:",
  '      modules: \'["bun", "pages"]\'',
  "      private: false",
  '      mounts: \'[{"path": "/", "versioned": true}]\'',
  "  pages:",
  "    needs: [all-green, release]",
  "    if: >-",
  "      !cancelled() &&",
  "      needs.all-green.result == 'success'",
  "    steps:",
  "      - uses: actions/checkout@v7",
  "      - uses: Vivswan/repo-platform/actions/all-green@build",
  "        with:",
  "          mode: report",
  "          label: nightly",
  "      - run: deno fmt --prose-wrap preserve",
  "",
].join("\n");

const UPDATES = [
  "updates:",
  '  - package-ecosystem: "github-actions"',
  "    commit-message:",
  '      prefix: "ci"',
  '  - package-ecosystem: "bun"',
  "    commit-message:",
  '      prefix: "build"',
  "",
].join("\n");

function fixture(): string {
  const root = temp.dir("smoke-gating-checks-");
  mkdirSync(join(root, "wf"));
  writeFileSync(join(root, "wf/ci.yml"), WORKFLOW);
  writeFileSync(join(root, "twin.yml"), WORKFLOW);
  writeFileSync(join(root, "other.yml"), `${WORKFLOW}# one more line\n`);
  writeFileSync(join(root, "wf/bare.yml"), "steps:\n  - run: deno fmt\n");
  writeFileSync(join(root, "dependabot.yml"), UPDATES);
  writeFileSync(join(root, "notes.md"), "## Node (x)\nline two\n## Node (x)\n1.2.3\n");
  writeFileSync(join(root, "good.json"), '{"skills": []}');
  writeFileSync(join(root, "bad.json"), "{skills: []}");
  symlinkSync("notes.md", join(root, "link.md"));
  return root;
}

const CI = "wf/ci.yml";

// Rows are [reason, check, passes]; each kind appears in both colors.
const cases: [string, Check, boolean][] = [
  ["exists: a regular file", { kind: "exists", path: "notes.md" }, true],
  ["exists: a directory is not a file", { kind: "exists", path: "wf" }, false],
  ["missing: an absent path", { kind: "missing", path: "nope.md" }, true],
  ["missing: a present path", { kind: "missing", path: "wf" }, false],
  ["symlink: the right target", { kind: "symlink", path: "link.md", target: "notes.md" }, true],
  ["symlink: a regular file", { kind: "symlink", path: "notes.md", target: "notes.md" }, false],
  ["symlink: another target", { kind: "symlink", path: "link.md", target: "other.md" }, false],
  [
    "text: has/hasLine/lacks/lacksLine all satisfied",
    {
      kind: "text",
      path: "notes.md",
      has: ["line two"],
      hasLine: ["1.2.3"],
      lacks: ["## Deno"],
      lacksLine: ["## Node"],
    },
    true,
  ],
  ["text: hasLine needs the WHOLE line", { kind: "text", path: CI, hasLine: ["name"] }, false],
  [
    "text: a missing required substring",
    { kind: "text", path: "notes.md", has: ["## Deno"] },
    false,
  ],
  [
    "text: a present forbidden exact line",
    { kind: "text", path: "notes.md", lacksLine: ["## Node (x)"] },
    false,
  ],
  [
    "text: lacks catches a comment mention",
    { kind: "text", path: CI, lacks: ["cancelled()"] },
    false,
  ],
  ["text: an unreadable file fails", { kind: "text", path: "nope.md", has: [] }, false],
  [
    "count: exact line count",
    { kind: "count", path: "notes.md", line: "## Node (x)", expected: 2 },
    true,
  ],
  [
    "count: substring count",
    { kind: "count", path: "notes.md", substring: "## Node", expected: 2 },
    true,
  ],
  [
    "count: off by one",
    { kind: "count", path: "notes.md", line: "## Node (x)", expected: 1 },
    false,
  ],
  [
    "line-matching: a whole-line version",
    { kind: "line-matching", path: "notes.md", pattern: /^\d+\.\d+\.\d+$/ },
    true,
  ],
  [
    "line-matching: no such line",
    { kind: "line-matching", path: "notes.md", pattern: /^\d+$/ },
    false,
  ],
  ["json: valid", { kind: "json", path: "good.json" }, true],
  ["json: unquoted keys", { kind: "json", path: "bad.json" }, false],
  [
    "yaml equals: a nested list",
    {
      kind: "yaml-equals",
      path: CI,
      at: ["jobs", "pages", "needs"],
      equals: ["all-green", "release"],
    },
    true,
  ],
  [
    "yaml equals: order matters",
    {
      kind: "yaml-equals",
      path: CI,
      at: ["jobs", "pages", "needs"],
      equals: ["release", "all-green"],
    },
    false,
  ],
  [
    "yaml equals: a boolean input",
    { kind: "yaml-equals", path: CI, at: ["jobs", "ci", "with", "private"], equals: false },
    true,
  ],
  [
    "yaml equals: a missing path",
    { kind: "yaml-equals", path: CI, at: ["jobs", "docs-site", "needs"], equals: [] },
    false,
  ],
  [
    "yaml equals: an exact mapping",
    { kind: "yaml-equals", path: CI, at: ["permissions"], equals: { contents: "read" } },
    true,
  ],
  [
    "yaml equals: an extra key fails",
    {
      kind: "yaml-equals",
      path: CI,
      at: ["permissions"],
      equals: { contents: "read", actions: "read" },
    },
    false,
  ],
  [
    "yaml matches: a step by partial with and Includes",
    {
      kind: "yaml-matches",
      path: CI,
      at: ["jobs", "pages", "steps"],
      matches: [{ uses: includes("actions/all-green@build"), with: { mode: "report" } }],
    },
    true,
  ],
  [
    "yaml matches: a partial that no step satisfies",
    {
      kind: "yaml-matches",
      path: CI,
      at: ["jobs", "pages", "steps"],
      matches: [{ uses: includes("actions/all-green@build"), with: { mode: "resolve" } }],
    },
    false,
  ],
  [
    "yaml matches: a multi-line if by substring",
    {
      kind: "yaml-matches",
      path: CI,
      at: ["jobs", "pages", "if"],
      matches: includes("!cancelled() &&"),
    },
    true,
  ],
  [
    "yaml matches: a substring the value lacks",
    { kind: "yaml-matches", path: CI, at: ["jobs", "pages", "if"], matches: includes("always()") },
    false,
  ],
  [
    "yaml pluck: ecosystem and prefix pairs in order",
    {
      kind: "yaml-pluck",
      path: "dependabot.yml",
      at: ["updates"],
      pluck: [["package-ecosystem"], ["commit-message", "prefix"]],
      equals: [
        ["github-actions", "ci"],
        ["bun", "build"],
      ],
    },
    true,
  ],
  [
    "yaml pluck: a missing entry",
    {
      kind: "yaml-pluck",
      path: "dependabot.yml",
      at: ["updates"],
      pluck: [["package-ecosystem"], ["commit-message", "prefix"]],
      equals: [["github-actions", "ci"]],
    },
    false,
  ],
  [
    "yaml-keys: exactly the top-level keys",
    { kind: "yaml-keys", path: CI, at: [], equals: ["name", "on", "permissions", "jobs"] },
    true,
  ],
  [
    "yaml-keys: a subset is not exact",
    { kind: "yaml-keys", path: CI, at: [], equals: ["name", "on"] },
    false,
  ],
  [
    "yaml-defined: a null-valued key is defined",
    { kind: "yaml-defined", path: CI, at: ["on", "workflow_dispatch"] },
    true,
  ],
  ["yaml-defined: an absent key", { kind: "yaml-defined", path: CI, at: ["on", "push"] }, false],
  ["yaml-absent: an absent key", { kind: "yaml-absent", path: CI, at: ["on", "push"] }, true],
  [
    "yaml-absent: a null-valued key is still present",
    { kind: "yaml-absent", path: CI, at: ["on", "workflow_dispatch"] },
    false,
  ],
  [
    "identical: the same bytes at another path",
    { kind: "identical", path: CI, reference: "twin.yml" },
    true,
  ],
  ["identical: one extra line", { kind: "identical", path: CI, reference: "other.yml" }, false],
  [
    "identical: a missing reference",
    { kind: "identical", path: CI, reference: "absent.yml" },
    false,
  ],
  [
    "deno-fmt-prose-preserved: a bare deno fmt in any workflow",
    { kind: "deno-fmt-prose-preserved", dir: "wf" },
    false,
  ],
];

describe("runChecks", () => {
  test.each(cases)("%s -> passes: %p", (_reason, check, passes) => {
    const root = fixture();
    const run = () => runChecks(root, [check], "(fixture)");
    if (passes) {
      run();
    } else {
      expect(run).toThrow(/gating check failed \(fixture\)/);
    }
  });

  test("the prose-wrap sweep passes once the bare spelling is gone, and fails on an empty dir", () => {
    const root = fixture();
    writeFileSync(join(root, "wf/bare.yml"), "steps:\n  - run: deno fmt --prose-wrap preserve\n");
    runChecks(root, [{ kind: "deno-fmt-prose-preserved", dir: "wf" }], "(fixture)");
    mkdirSync(join(root, "empty"));
    expect(() =>
      runChecks(root, [{ kind: "deno-fmt-prose-preserved", dir: "empty" }], "(fixture)"),
    ).toThrow(/rendered workflows to sweep/);
  });

  test("every failure in a batch is reported, not just the first", () => {
    const root = fixture();
    expect(() =>
      runChecks(
        root,
        [
          { kind: "missing", path: "wf" },
          { kind: "exists", path: "nope.md" },
        ],
        "(fixture)",
      ),
    ).toThrow(/wf: expected nothing rendered[\s\S]*nope\.md: expected a rendered file/);
  });
});

describe("the structural helpers", () => {
  test("valueAt tells a null value from a missing key", () => {
    const doc = { on: { workflow_dispatch: null } };
    expect(valueAt(doc, ["on", "workflow_dispatch"])).toBeNull();
    expect(valueAt(doc, ["on", "push"])).not.toBeNull();
    expect(valueAt(doc, ["on", "workflow_dispatch", "inputs"])).not.toBeNull();
  });

  test("matchesPartial: subset objects, some-element arrays, Includes, strict scalars", () => {
    const steps = [{ uses: "a@build", with: { mode: "report", extra: 1 } }, { run: "echo" }];
    expect(matchesPartial(steps, [{ with: { mode: "report" } }, { run: includes("ech") }])).toBe(
      true,
    );
    expect(matchesPartial(steps, [{ with: { mode: "resolve" } }])).toBe(false);
    expect(matchesPartial("false", false)).toBe(false);
    expect(matchesPartial(null, {})).toBe(false);
    expect(matchesPartial([1], {})).toBe(false);
  });
});
