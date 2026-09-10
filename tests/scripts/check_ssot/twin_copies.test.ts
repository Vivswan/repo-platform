// The twin-copy rules' pure helpers (scripts/check/ssot/twin_copies.ts).

import { describe, expect, test } from "bun:test";
import {
  type DogfoodPair,
  dogfoodPairMismatches,
  LICENSE_TEMPLATE,
  licenseCopies,
  ownershipTableMismatches,
} from "../../../scripts/check/ssot/twin_copies.ts";

describe("ownershipTableMismatches", () => {
  const table = (rows: string[], rule = "Decision") =>
    `# Title\n\nprose\n\n| Class | Files | ${rule} |\n|---|---|---|\n${rows.join("\n")}\n`;
  const reference = table(
    [
      "| Managed | `ci.yml`, `release.yml` | accept |",
      "| Split | `AGENTS.md` | keep both halves |",
    ],
    "What it means",
  );
  const twin = (rows: string[]) => [
    { file: "a.md", markdown: reference },
    { file: "b.md", markdown: table(rows) },
  ];

  test("twins differing only in the third column and prose yield nothing (the control)", () => {
    expect(
      ownershipTableMismatches(
        twin([
          "| Managed | `ci.yml`, `release.yml` | never edit |",
          "| Split | `AGENTS.md` | ok |",
        ]),
      ),
    ).toEqual([]);
  });

  test.each<{ reason: string; rows: string[]; expected: string; got: string }>([
    {
      reason: "a Files cell that drifted",
      rows: ["| Managed | `ci.yml` | never edit |", "| Split | `AGENTS.md` | ok |"],
      expected: '"Managed | `ci.yml`, `release.yml`" (line 3 vs a.md)',
      got: '"Managed | `ci.yml`"',
    },
    {
      reason: "a row present in one table only",
      rows: [
        "| Managed | `ci.yml`, `release.yml` | never edit |",
        "| Split | `AGENTS.md` | ok |",
        "| Starter | `settings.yml` | fill in |",
      ],
      expected: '"<end of file>" (line 5 vs a.md)',
      got: '"Starter | `settings.yml`"',
    },
  ])("$reason names the first differing row", ({ rows, expected, got }) => {
    expect(ownershipTableMismatches(twin(rows))).toEqual([{ file: "b.md", expected, got }]);
  });

  test("a second table after the roster is not read into it", () => {
    const trailing = [
      table(["| Managed | `ci.yml`, `release.yml` | never edit |", "| Split | `AGENTS.md` | ok |"]),
      "Notes:",
      "",
      "| Module | Files |",
      "|---|---|",
      "| bun | `.bun-version` |",
      "",
    ].join("\n");
    expect(
      ownershipTableMismatches([
        { file: "a.md", markdown: reference },
        { file: "b.md", markdown: trailing },
      ]),
    ).toEqual([]);
  });

  test.each([
    { reason: "prose only", markdown: "# Title\n\nprose only\n" },
    {
      reason: "a decoy table without the ownership header",
      markdown:
        "# Title\n\n| Module | Files | Notes |\n|---|---|---|\n| bun | `.bun-version` | pin |\n",
    },
  ])("a file with no ownership header is a lost anchor: $reason", ({ markdown }) => {
    expect(() =>
      ownershipTableMismatches([
        { file: "a.md", markdown: reference },
        { file: "b.md", markdown },
      ]),
    ).toThrow(/b\.md: no \| Class \| Files \| table header - anchor lost/);
  });
});

describe("dogfood-parity (licenseCopies and dogfoodPairMismatches)", () => {
  const SKILL_COPIES = [
    "skills/repo-platform-add-module/LICENSE.md",
    "skills/repo-platform-new-project/LICENSE.md",
    "skills/repo-platform-sync-pr/LICENSE.md",
  ];
  const TRACKED = [
    "tests/golden-renders/minimal/LICENSE.md",
    "tests/ci/files_fidelity/renders/minimal/LICENSE.md",
    "files/base/LICENSE.md",
    ...SKILL_COPIES,
    LICENSE_TEMPLATE,
    "LICENSE.md",
    "docs/LICENSE.md.txt",
    "package.json",
  ];

  test("licenseCopies keeps the root and every skill copy, sorted, and drops the template, the writer source, and the renders", () => {
    expect(licenseCopies(TRACKED)).toEqual(["LICENSE.md", ...SKILL_COPIES]);
  });

  test("a fifth copy anywhere in the tracked tree is discovered without a roster edit", () => {
    expect(licenseCopies([...TRACKED, "actions/new-action/LICENSE.md"])).toContain(
      "actions/new-action/LICENSE.md",
    );
  });

  test("a tracked tree without the root LICENSE.md is a lost anchor", () => {
    expect(() => licenseCopies(SKILL_COPIES)).toThrow(/no tracked root LICENSE.md - anchor lost/);
  });

  const rendered = [
    "<!-- BEGIN REPO-PLATFORM MANAGED -->",
    "# Individual and Small Organization License 1.1.0",
    "",
    "Required Notice: Copyright Vivswan Shah",
    "<!-- END REPO-PLATFORM MANAGED -->",
    "",
  ].join("\n");
  const pair: DogfoodPair = { repo: SKILL_COPIES[2], tpl: LICENSE_TEMPLATE, mode: "prefix" };

  test("a prefix copy passes when it starts with the render, with or without a repo-owned tail", () => {
    expect(dogfoodPairMismatches(pair, rendered, rendered)).toEqual([]);
    expect(dogfoodPairMismatches(pair, rendered, `${rendered}\nThird-party notices.\n`)).toEqual(
      [],
    );
  });

  test("planted control: a skill copy left on the previous license version is red at its heading line", () => {
    const stale = rendered.replace("License 1.1.0", "License 1.0.0");
    expect(dogfoodPairMismatches(pair, rendered, stale)).toEqual([
      {
        file: SKILL_COPIES[2],
        expected: `"# Individual and Small Organization License 1.1.0" (line 2 vs ${LICENSE_TEMPLATE})`,
        got: '"# Individual and Small Organization License 1.0.0"',
      },
    ]);
  });

  test("a prefix copy missing its managed region's last line is red at end of file", () => {
    const truncated = rendered.split("\n").slice(0, 3).join("\n");
    expect(dogfoodPairMismatches(pair, rendered, truncated).map((m) => m.got)).toEqual([
      '"<end of file>"',
    ]);
  });

  test("a semantic pair ignores comments and blanks but flags a changed line", () => {
    const semantic: DogfoodPair = { repo: "x.yml", tpl: "x.yml.jinja", mode: "semantic" };
    expect(dogfoodPairMismatches(semantic, "a: 1\n# note\nb: 2\n", "a: 1\n\nb: 2\n")).toEqual([]);
    expect(
      dogfoodPairMismatches(semantic, "a: 1\nb: 2\n", "a: 1\nb: 3\n").map((m) => m.got),
    ).toEqual(['"b: 3"']);
  });
});
