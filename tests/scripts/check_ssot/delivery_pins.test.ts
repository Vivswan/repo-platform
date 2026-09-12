import { describe, expect, test } from "bun:test";
import type { Mismatch } from "../../../scripts/check/ssot/comparison.ts";
import {
  BRANCH_PINNED,
  callableWorkflowNames,
  deliveryRefMismatches,
  deliveryRefTwinMismatches,
  extractUsesPins,
  fleetWorkflowPinMismatches,
  type Pin,
  pinMismatches,
  pinShapeMismatches,
  sourceSelfPins,
  stemMismatches,
  workflowFiles,
} from "../../../scripts/check/ssot/delivery_pins.ts";

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

describe("extractUsesPins", () => {
  const text = [
    "      - uses: actions/checkout@v7",
    `      # - uses: astral-sh/setup-uv@${SHA} # v10.0.1`,
    "      - uses: ./actions/check-typography",
    "    uses: {{github_username}}/repo-platform/actions/x@stable",
    `    uses: github/codeql-action/init@${SHA} # v4.38.0`,
    `    uses: "actions/cache@${SHA}" # v6.1.0`,
  ].join("\n");

  test("extracts real pins with their version comment, commented examples included; local and placeholder-owner lines are skipped", () => {
    expect(extractUsesPins(text, "f")).toEqual([
      { file: "f", action: "actions/checkout", ref: "v7", version: null },
      { file: "f", action: "astral-sh/setup-uv", ref: SHA, version: "v10.0.1" },
      { file: "f", action: "github/codeql-action", ref: SHA, version: "v4.38.0" },
      { file: "f", action: "actions/cache", ref: SHA, version: "v6.1.0" },
    ]);
  });

  test("extracts quoted pins", () => {
    const pins = extractUsesPins('      - uses: "actions/checkout@v8"', "f");
    expect(pins).toEqual([{ file: "f", action: "actions/checkout", ref: "v8", version: null }]);
  });
});

describe("pinShapeMismatches", () => {
  const pin = (file: string, action: string, ref: string, version: string | null): Pin => ({
    file,
    action,
    ref,
    version,
  });
  const branchPinned = { "dtolnay/rust-toolchain": "master" };

  test("passes sha pins with release comments, the platform's own delivery ref, and the allowlisted branch pin", () => {
    const pins = [
      pin("a.yml", "actions/checkout", SHA, "v7.0.1"),
      pin("b.yml", "actions/checkout", SHA, "v7.0.1"),
      pin("a.yml", "dtolnay/rust-toolchain", SHA, "master"),
      pin("a.yml", "Vivswan/repo-platform", "build", null),
      pin("a.yml", "vivswan/github-settings-as-code", SHA, "v2.0.0"),
    ];
    expect(pinShapeMismatches(pins, "Vivswan", branchPinned)).toEqual([]);
  });

  // Only repo-platform's own refs ride the green-gated delivery branch; the owner's other
  // repositories are upstream code like any third party's, frozen by sha the same way.
  test.each<{ got: string; ref: string; version: string | null; expected: Mismatch[] }>([
    { got: "sha # main", ref: SHA, version: "main", expected: [] },
    {
      got: "@main",
      ref: "main",
      version: null,
      expected: [
        {
          file: "ci.yml",
          expected: "Vivswan/skills@<full 40-hex commit sha> # main",
          got: "@main",
        },
      ],
    },
    {
      got: "sha # v1.0.0",
      ref: SHA,
      version: "v1.0.0",
      expected: [
        {
          file: "ci.yml",
          expected: "Vivswan/skills@<full 40-hex commit sha> # main",
          got: `@${SHA} # v1.0.0`,
        },
      ],
    },
  ])(
    "the owner's other repositories are third parties: Vivswan/skills at $got against the live allowlist",
    ({ ref, version, expected }) => {
      expect(BRANCH_PINNED["Vivswan/skills"]).toBe("main");
      expect(
        pinShapeMismatches(
          [
            pin("ci.yml", "Vivswan/skills", ref, version),
            pin("a.yml", "actions/checkout", SHA, "v7.0.1"),
          ],
          "Vivswan",
          BRANCH_PINNED,
        ),
      ).toEqual(expected);
    },
  );

  test.each<{ reason: string; pins: Pin[]; expected: Mismatch[] }>([
    {
      reason: "a moving tag",
      pins: [
        pin("a.yml", "actions/checkout", "v7", null),
        pin("a.yml", "dtolnay/rust-toolchain", SHA, "master"),
      ],
      expected: [
        {
          file: "a.yml",
          expected: "actions/checkout@<full 40-hex commit sha> # v<major>.<minor>.<patch>",
          got: "@v7",
        },
      ],
    },
    {
      reason: "a sha without its version comment",
      pins: [
        pin("a.yml", "actions/checkout", SHA, null),
        pin("a.yml", "dtolnay/rust-toolchain", SHA, "master"),
      ],
      expected: [
        {
          file: "a.yml",
          expected: "actions/checkout@<full 40-hex commit sha> # v<major>.<minor>.<patch>",
          got: `@${SHA}`,
        },
      ],
    },
    {
      reason: "a sha whose comment is a moving major, and an abbreviated sha",
      pins: [
        pin("a.yml", "actions/checkout", SHA, "v7"),
        pin("b.yml", "actions/cache", SHA.slice(0, 12), "v6.1.0"),
        pin("a.yml", "dtolnay/rust-toolchain", SHA, "master"),
      ],
      expected: [
        {
          file: "a.yml",
          expected: "actions/checkout@<full 40-hex commit sha> # v<major>.<minor>.<patch>",
          got: `@${SHA} # v7`,
        },
        {
          file: "b.yml",
          expected: "actions/cache@<full 40-hex commit sha> # v<major>.<minor>.<patch>",
          got: `@${SHA.slice(0, 12)} # v6.1.0`,
        },
      ],
    },
    {
      reason: "one sha carrying two version comments",
      pins: [
        pin("a.yml", "actions/checkout", SHA, "v7.0.1"),
        pin("b.yml", "actions/checkout", SHA, "v7.0.0"),
        pin("a.yml", "dtolnay/rust-toolchain", SHA, "master"),
      ],
      expected: [
        {
          file: `actions/checkout@${SHA}`,
          expected: "one version comment per pinned sha",
          got: "v7.0.0, v7.0.1",
        },
      ],
    },
    {
      reason: "a branch-pinned action naming another branch, and a stale allowlist entry",
      pins: [pin("a.yml", "dtolnay/rust-toolchain", SHA, "stable")],
      expected: [
        {
          file: "a.yml",
          expected: "dtolnay/rust-toolchain@<full 40-hex commit sha> # master",
          got: `@${SHA} # stable`,
        },
      ],
    },
    {
      reason: "an allowlisted branch pin no longer present anywhere",
      pins: [pin("a.yml", "actions/checkout", SHA, "v7.0.1")],
      expected: [
        {
          file: "dtolnay/rust-toolchain",
          expected: "an action still pinned somewhere (branch-pinned allowlist)",
          got: "no uses: pins found (stale allowlist entry - remove it)",
        },
      ],
    },
    {
      reason: "the owner's other repository at a moving ref, in any owner spelling",
      pins: [
        pin("a.yml", "vivswan/github-settings-as-code", "latest", null),
        pin("a.yml", "dtolnay/rust-toolchain", SHA, "master"),
      ],
      expected: [
        {
          file: "a.yml",
          expected:
            "vivswan/github-settings-as-code@<full 40-hex commit sha> # v<major>.<minor>.<patch>",
          got: "@latest",
        },
      ],
    },
  ])("flags $reason", ({ pins, expected }) => {
    expect(pinShapeMismatches(pins, "Vivswan", branchPinned)).toEqual(expected);
  });
});

describe("pinMismatches", () => {
  const split = [
    { file: "a.yml", action: "x/y", ref: "v1", version: null },
    { file: "b.yml", action: "x/y", ref: "v2", version: null },
  ];

  test("passes when every action maps to one ref", () => {
    expect(pinMismatches([{ file: "a.yml", action: "x/y", ref: "v1", version: null }])).toEqual([]);
  });

  test("flags an action pinned at two refs, naming the sites, with no allowance for a split", () => {
    expect(pinMismatches(split)).toEqual([
      { file: "x/y", expected: "a single pinned ref", got: "v1 (a.yml); v2 (b.yml)" },
    ]);
  });
});

describe("sourceSelfPins and deliveryRefMismatches (fleet-refs-ride-stable)", () => {
  test("DELIVERY_REF must be the tag move_stable.ts moves, either rename alone reds", () => {
    expect(deliveryRefTwinMismatches("refs/tags/stable", "stable")).toEqual([]);
    for (const [moved, deliveryRef] of [
      ["refs/tags/stable2", "stable"],
      ["refs/tags/stable", "stable2"],
      ["refs/heads/stable", "stable"],
    ]) {
      expect(deliveryRefTwinMismatches(moved, deliveryRef)).toEqual([
        {
          file: "scripts/check/ssot/delivery_pins.ts DELIVERY_REF",
          expected: `the tag of move_stable.ts's TAG '${moved}' (the ref the fleet's pins execute from)`,
          got: `'${deliveryRef}'`,
        },
      ]);
    }
  });

  test("extracts the sources' delivery pins - actions and reusable workflows alike", () => {
    const text = [
      "      - uses: {{github_username}}/repo-platform/actions/fuzz-issue@stable",
      "    uses: {{github_username}}/repo-platform/.github/workflows/reusable-pages.yml@main",
    ].join("\n");
    expect(sourceSelfPins(text, "f")).toEqual([
      { file: "f", stem: "repo-platform/actions/fuzz-issue", ref: "stable" },
      { file: "f", stem: "repo-platform/.github/workflows/reusable-pages.yml", ref: "main" },
    ]);
  });

  test("third-party, local, other-repo, other-placeholder, and prose refs are not self-pins", () => {
    const text = [
      "      - uses: actions/checkout@v7",
      "      - uses: ./actions/local",
      "      - uses: {{github_username}}/other-repo/actions/x@main",
      "      - uses: {{other_owner}}/repo-platform/actions/x@main",
      "      - uses: x{{github_username}}/repo-platform/actions/x@main",
      "      - uses: xVivswan/repo-platform/actions/x@main",
      "- Exception: `Vivswan/repo-platform/...@build` references stay on the delivery ref.",
    ].join("\n");
    expect(sourceSelfPins(text, "f")).toEqual([]);
  });

  test("the literal owner in any case is a self-pin too, in a workflow, a manifest, or a doc's code span", () => {
    const text = [
      "      - uses: Vivswan/repo-platform/actions/plan@build",
      "      uses: vivswan/repo-platform/actions/bun-setup@build",
      "    uses: Vivswan/repo-platform/.github/workflows/reusable-site.yml@main",
      "Each action calls bun-setup (`uses: Vivswan/repo-platform/actions/bun-setup@build` with `pin` set).",
    ].join("\n");
    expect(sourceSelfPins(text, "f")).toEqual([
      { file: "f", stem: "repo-platform/actions/plan", ref: "build" },
      { file: "f", stem: "repo-platform/actions/bun-setup", ref: "build" },
      { file: "f", stem: "repo-platform/.github/workflows/reusable-site.yml", ref: "main" },
      { file: "f", stem: "repo-platform/actions/bun-setup", ref: "build" },
    ]);
  });

  test("a planted @main source ref reds, naming the file and the offending ref", () => {
    const planted =
      "    uses: {{github_username}}/repo-platform/.github/workflows/reusable-pages.yml@main";
    const file = "files/pages/.github/workflows/pages.yml";
    const mismatches = deliveryRefMismatches(sourceSelfPins(planted, file), "stable");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].file).toBe(file);
    expect(mismatches[0].expected).toContain(
      "repo-platform/.github/workflows/reusable-pages.yml@stable",
    );
    expect(mismatches[0].got).toBe("@main");
    const restored = planted.replace("@main", "@stable");
    expect(deliveryRefMismatches(sourceSelfPins(restored, file), "stable")).toEqual([]);
  });

  test("any non-delivery ref reds, not just @main - the retired build branch, a tag, or a sha forks the channel too", () => {
    for (const ref of ["build", "v2"]) {
      const pins = [{ file: "f", stem: "repo-platform/actions/x", ref }];
      expect(deliveryRefMismatches(pins, "stable")[0].got).toBe(`@${ref}`);
    }
  });

  test("the lowered-username placeholder is scanned too, in any spacing - it substitutes a working owner", () => {
    const planted =
      "    uses: {{github_username_lower}}/repo-platform/.github/workflows/reusable-pages.yml@main";
    const pins = sourceSelfPins(planted, "f");
    expect(pins).toEqual([
      { file: "f", stem: "repo-platform/.github/workflows/reusable-pages.yml", ref: "main" },
    ]);
    expect(deliveryRefMismatches(pins, "stable")).toHaveLength(1);
    for (const owner of [
      "{{ github_username }}",
      "{{github_username_lower}}",
      "{{ github_username_lower }}",
    ]) {
      expect(sourceSelfPins(`uses: ${owner}/repo-platform/actions/x@main`, "f")).toEqual([
        { file: "f", stem: "repo-platform/actions/x", ref: "main" },
      ]);
    }
  });

  test("a reusable-workflow pin on a workflow that is not callable reds - right ref, still a failed call", () => {
    const offRoster = [
      { file: "f", stem: "repo-platform/.github/workflows/reusable-ghost.yml", ref: "stable" },
    ];
    const mismatches = fleetWorkflowPinMismatches(offRoster, ["fleet-ci.yml"]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].got).toBe("repo-platform/.github/workflows/reusable-ghost.yml");
    expect(mismatches[0].expected).toContain(
      "workflow_call workflow under .github/workflows [fleet-ci.yml]",
    );
    // A callable pin and an action pin both pass: an action directory at the delivery commit always resolves.
    expect(
      fleetWorkflowPinMismatches(
        [
          { file: "f", stem: "repo-platform/.github/workflows/fleet-ci.yml", ref: "stable" },
          { file: "f", stem: "repo-platform/actions/fuzz-issue", ref: "stable" },
        ],
        ["fleet-ci.yml"],
      ),
    ).toEqual([]);
  });

  test("the callable roster is every workflow_call workflow under .github/workflows and nothing else", () => {
    const callable = callableWorkflowNames(workflowFiles());
    // Every workflow the skeleton and the managed workflows pin, plus the one fleet-ci calls by `./` path.
    for (const name of [
      "fleet-ci.yml",
      "fleet-nightly.yml",
      "fleet-release.yml",
      "fleet-release-publish.yml",
      "reusable-auto-assign.yml",
      "reusable-auto-assign-alerts.yml",
      "reusable-codeql.yml",
      "reusable-site.yml",
      "post-green.yml",
    ]) {
      expect(callable).toContain(name);
    }
    // Workflows with no workflow_call trigger are not callable, whatever ref a pin names.
    expect(callable).not.toContain("ci.yml");
    expect(callable).not.toContain("protect-build-branches.yml");
  });

  test("the callable roster takes every workflow_call spelling, only directly under .github/workflows", () => {
    const at = (name: string, text: string) => ({ path: `.github/workflows/${name}`, text });
    expect(
      callableWorkflowNames([
        at("mapping.yml", "on:\n  workflow_call:\n    inputs: {}\n"),
        at("string.yaml", "on: workflow_call\n"),
        at("list.yml", "on: [push, workflow_call]\n"),
        at("push.yml", "on: push\n"),
        at("nested/call.yml", "on: workflow_call\n"),
        at("notes.md", "on: workflow_call\n"),
      ]),
    ).toEqual(["list.yml", "mapping.yml", "string.yaml"]);
  });

  test("an empty scan throws - anchor lost, never a silently green rule", () => {
    expect(() => deliveryRefMismatches([], "stable")).toThrow("anchor lost");
  });
});

describe("stemMismatches (delivery-pin-stems)", () => {
  const tree = new Set([
    "actions/plan/action.yml",
    "actions/pages-site/check-links/action.yaml",
    ".github/workflows/reusable-site.yml",
  ]);
  const exists = (rel: string) => tree.has(rel);
  const missing = (wanted: string) =>
    `${wanted} in the checkout (a uses: fetches it at the ref, so a missing stem 404s every caller)`;

  test("a pin on a missing action directory reds, naming the file, the stem, and the ref as written", () => {
    const planted = [
      "      - uses: Vivswan/repo-platform/actions/plan@build",
      "      - uses: Vivswan/repo-platform/actions/does-not-exist@build",
    ].join("\n");
    const file = ".github/workflows/fleet-ci.yml";
    expect(stemMismatches(sourceSelfPins(planted, file), exists)).toEqual([
      {
        file,
        expected: missing(
          "actions/does-not-exist/action.yml or actions/does-not-exist/action.yaml",
        ),
        got: "repo-platform/actions/does-not-exist@build (no such path)",
      },
    ]);
  });

  test("the ref is data: under any tag or branch a missing stem reds and a present one passes", () => {
    for (const ref of ["build", "stable", "v2"]) {
      const text = [
        `      - uses: {{github_username}}/repo-platform/actions/does-not-exist@${ref}`,
        `    uses: {{github_username}}/repo-platform/.github/workflows/reusable-site.yml@${ref}`,
      ].join("\n");
      expect(stemMismatches(sourceSelfPins(text, "f"), exists)).toEqual([
        {
          file: "f",
          expected: missing(
            "actions/does-not-exist/action.yml or actions/does-not-exist/action.yaml",
          ),
          got: `repo-platform/actions/does-not-exist@${ref} (no such path)`,
        },
      ]);
    }
  });

  test("present stems pass in every shape: an action, a nested action with the yaml spelling, a reusable workflow", () => {
    const pins = [
      { file: "a", stem: "repo-platform/actions/plan", ref: "build" },
      { file: "a", stem: "repo-platform/actions/pages-site/check-links", ref: "build" },
      { file: "b", stem: "repo-platform/.github/workflows/reusable-site.yml", ref: "build" },
    ];
    expect(stemMismatches(pins, exists)).toEqual([]);
  });

  test("a missing reusable workflow is one file; a stem outside actions/ is asked for a manifest like any directory", () => {
    const pins = [
      { file: "a", stem: "repo-platform/.github/workflows/reusable-ghost.yml", ref: "build" },
      { file: "b", stem: "repo-platform/scripts/run_tests.ts", ref: "build" },
    ];
    expect(stemMismatches(pins, exists)).toEqual([
      {
        file: "a",
        expected: missing(".github/workflows/reusable-ghost.yml"),
        got: "repo-platform/.github/workflows/reusable-ghost.yml@build (no such path)",
      },
      {
        file: "b",
        expected: missing("scripts/run_tests.ts/action.yml or scripts/run_tests.ts/action.yaml"),
        got: "repo-platform/scripts/run_tests.ts@build (no such path)",
      },
    ]);
  });

  test("an empty scan throws - anchor lost, never a silently green rule", () => {
    expect(() => stemMismatches([], exists)).toThrow("anchor lost");
  });
});
