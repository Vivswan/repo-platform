// The delivery-pin rules' pure helpers (scripts/check/ssot/delivery_pins.ts).

import { describe, expect, test } from "bun:test";
import type { Mismatch } from "../../../scripts/check/ssot/comparison.ts";
import {
  deliveryRefMismatches,
  deliveryRefTwinMismatches,
  extractUsesPins,
  fleetWorkflowPinMismatches,
  type Pin,
  pinMismatches,
  pinShapeMismatches,
  sourceSelfPins,
} from "../../../scripts/check/ssot/delivery_pins.ts";

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

describe("extractUsesPins", () => {
  const text = [
    "      - uses: actions/checkout@v7",
    `      # - uses: astral-sh/setup-uv@${SHA} # v10.0.1`,
    "      - uses: ./actions/check-typography",
    "    uses: {{github_username}}/repo-platform/actions/x@build",
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

  test("passes sha pins with release comments, the owner's own refs, and the allowlisted branch pin", () => {
    const pins = [
      pin("a.yml", "actions/checkout", SHA, "v7.0.1"),
      pin("b.yml", "actions/checkout", SHA, "v7.0.1"),
      pin("a.yml", "dtolnay/rust-toolchain", SHA, "master"),
      pin("a.yml", "Vivswan/repo-platform", "build", null),
      pin("a.yml", "vivswan/github-settings-as-code", "latest", null),
    ];
    expect(pinShapeMismatches(pins, "Vivswan", branchPinned)).toEqual([]);
  });

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

describe("sourceSelfPins and deliveryRefMismatches (fleet-refs-ride-build)", () => {
  test("DELIVERY_REF must equal the branch publish.ts advances, either rename alone reds", () => {
    expect(deliveryRefTwinMismatches("build", "build")).toEqual([]);
    for (const [published, deliveryRef] of [
      ["build2", "build"],
      ["build", "build2"],
    ]) {
      expect(deliveryRefTwinMismatches(published, deliveryRef)).toEqual([
        {
          file: "scripts/check/ssot/delivery_pins.ts DELIVERY_REF",
          expected: `'${published}' (publish.ts's BRANCH - the branch the fleet's pins execute from)`,
          got: `'${deliveryRef}'`,
        },
      ]);
    }
  });

  test("extracts the sources' delivery pins - actions and reusable workflows alike", () => {
    const text = [
      "      - uses: {{github_username}}/repo-platform/actions/fuzz-issue@build",
      "    uses: {{github_username}}/repo-platform/.github/workflows/reusable-pages.yml@main",
    ].join("\n");
    expect(sourceSelfPins(text, "f")).toEqual([
      { file: "f", stem: "repo-platform/actions/fuzz-issue", ref: "build" },
      { file: "f", stem: "repo-platform/.github/workflows/reusable-pages.yml", ref: "main" },
    ]);
  });

  test("third-party, local, other-repo, literal-owner, and other-placeholder refs are not self-pins", () => {
    const text = [
      "      - uses: actions/checkout@v7",
      "      - uses: ./actions/local",
      "      - uses: {{github_username}}/other-repo/actions/x@main",
      "      - uses: Vivswan/repo-platform/actions/x@main",
      "      - uses: {{other_owner}}/repo-platform/actions/x@main",
      "      - uses: x{{github_username}}/repo-platform/actions/x@main",
    ].join("\n");
    expect(sourceSelfPins(text, "f")).toEqual([]);
  });

  test("a planted @main source ref reds, naming the file and the offending ref", () => {
    const planted =
      "    uses: {{github_username}}/repo-platform/.github/workflows/reusable-pages.yml@main";
    const file = "files/pages/.github/workflows/pages.yml";
    const mismatches = deliveryRefMismatches(sourceSelfPins(planted, file), "build");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].file).toBe(file);
    expect(mismatches[0].expected).toContain(
      "repo-platform/.github/workflows/reusable-pages.yml@build",
    );
    expect(mismatches[0].got).toBe("@main");
    // Restored to the delivery ref, the same content is green.
    const restored = planted.replace("@main", "@build");
    expect(deliveryRefMismatches(sourceSelfPins(restored, file), "build")).toEqual([]);
  });

  test("any non-delivery ref reds, not just @main - a tag or sha forks the channel too", () => {
    const pins = [{ file: "f", stem: "repo-platform/actions/x", ref: "v2" }];
    expect(deliveryRefMismatches(pins, "build")[0].got).toBe("@v2");
  });

  test("the lowered-username placeholder is scanned too, in any spacing - it substitutes a working owner", () => {
    const planted =
      "    uses: {{github_username_lower}}/repo-platform/.github/workflows/reusable-pages.yml@main";
    const pins = sourceSelfPins(planted, "f");
    expect(pins).toEqual([
      { file: "f", stem: "repo-platform/.github/workflows/reusable-pages.yml", ref: "main" },
    ]);
    expect(deliveryRefMismatches(pins, "build")).toHaveLength(1);
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

  test("a reusable-workflow pin off the FLEET_WORKFLOWS roster reds - right ref, still a 404", () => {
    const offRoster = [
      { file: "f", stem: "repo-platform/.github/workflows/reusable-ghost.yml", ref: "build" },
    ];
    const mismatches = fleetWorkflowPinMismatches(offRoster, ["fleet-ci.yml"]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].got).toBe("repo-platform/.github/workflows/reusable-ghost.yml");
    expect(mismatches[0].expected).toContain("FLEET_WORKFLOWS");
    // A rostered pin and an action pin both pass - actions ship whole.
    expect(
      fleetWorkflowPinMismatches(
        [
          { file: "f", stem: "repo-platform/.github/workflows/fleet-ci.yml", ref: "build" },
          { file: "f", stem: "repo-platform/actions/fuzz-issue", ref: "build" },
        ],
        ["fleet-ci.yml"],
      ),
    ).toEqual([]);
  });

  test("an empty scan throws - anchor lost, never a silently green rule", () => {
    expect(() => deliveryRefMismatches([], "build")).toThrow("anchor lost");
  });
});
