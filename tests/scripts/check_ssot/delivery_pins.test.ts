import { describe, expect, test } from "bun:test";
import {
  callableWorkflowNames,
  deliveryRefMismatches,
  deliveryRefTwinMismatches,
  extractUsesPins,
  fleetWorkflowPinMismatches,
  type Pin,
  sourceSelfPins,
  stemMismatches,
  unverifiableVersionCommentMismatches,
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

describe("unverifiableVersionCommentMismatches (version-comments-verifiable)", () => {
  const pin = (version: string | null): Pin => ({
    file: "a.yml",
    action: "actions/checkout",
    ref: SHA,
    version,
  });

  // A full version pinact resolves against the commit, a suffixed or `tag=`-prefixed one included; a comment outside its
  // `v?<digit>` grammar (`main`, `V7.0.1`) and no comment at all are pinact's own refusals (code 005), so the rule leaves them to it.
  test("passes every comment pinact judges itself", () => {
    const judged = [
      "v7.0.1",
      "7.0.1",
      "v7.0.1-rc",
      "v9.0.0.0",
      "tag=v7.0.1",
      "main",
      "tag=main",
      `main-${SHA}`,
      "V7.0.1",
      null,
    ];
    expect(unverifiableVersionCommentMismatches(judged.map(pin))).toEqual([]);
  });

  // The last two ride pinact's classifier order: `tag=` is dropped before classifying, and a 40-hex word anywhere makes
  // the comment a sha before the full-version shape is even tried.
  test.each([
    "v999",
    "v7",
    "v7.0",
    "999",
    "7",
    "v999-beta",
    "2024-01",
    "tag=v999-beta",
    `v7.0.1-${SHA}`,
  ])(
    "a `# %s` comment reds: pinact reads it as a version but verifies only the full shape, so the line passes unverified",
    (version) => {
      expect(unverifiableVersionCommentMismatches([pin(version)])).toEqual([
        {
          file: "a.yml",
          expected: `actions/checkout@${SHA} # v<major>.<minor>.<patch> (pinact verifies a full version against its commit; any other numeric comment passes unverified, sha included)`,
          got: `# ${version}`,
        },
      ]);
    },
  );
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
      "- Exception: `Vivswan/repo-platform/...@stable` references stay on the delivery ref.",
    ].join("\n");
    expect(sourceSelfPins(text, "f")).toEqual([]);
  });

  test("the literal owner in any case is a self-pin too, in a workflow, a manifest, or a doc's code span", () => {
    const text = [
      "      - uses: Vivswan/repo-platform/actions/plan@stable",
      "      uses: vivswan/repo-platform/actions/bun-setup@stable",
      "    uses: Vivswan/repo-platform/.github/workflows/reusable-site.yml@main",
      "Each action calls bun-setup (`uses: Vivswan/repo-platform/actions/bun-setup@stable` with `pin` set).",
    ].join("\n");
    expect(sourceSelfPins(text, "f")).toEqual([
      { file: "f", stem: "repo-platform/actions/plan", ref: "stable" },
      { file: "f", stem: "repo-platform/actions/bun-setup", ref: "stable" },
      { file: "f", stem: "repo-platform/.github/workflows/reusable-site.yml", ref: "main" },
      { file: "f", stem: "repo-platform/actions/bun-setup", ref: "stable" },
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

  test("any non-delivery ref reds, not just @main - another branch, a tag, or a sha forks the channel too", () => {
    for (const ref of ["next", "v2"]) {
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
    expect(callable).not.toContain("refresh-toolchains.yml");
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
      "      - uses: Vivswan/repo-platform/actions/plan@stable",
      "      - uses: Vivswan/repo-platform/actions/does-not-exist@stable",
    ].join("\n");
    const file = ".github/workflows/fleet-ci.yml";
    expect(stemMismatches(sourceSelfPins(planted, file), exists)).toEqual([
      {
        file,
        expected: missing(
          "actions/does-not-exist/action.yml or actions/does-not-exist/action.yaml",
        ),
        got: "repo-platform/actions/does-not-exist@stable (no such path)",
      },
    ]);
  });

  test("the ref is data: under any tag or branch a missing stem reds and a present one passes", () => {
    for (const ref of ["next", "stable", "v2"]) {
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
      { file: "a", stem: "repo-platform/actions/plan", ref: "stable" },
      { file: "a", stem: "repo-platform/actions/pages-site/check-links", ref: "stable" },
      { file: "b", stem: "repo-platform/.github/workflows/reusable-site.yml", ref: "stable" },
    ];
    expect(stemMismatches(pins, exists)).toEqual([]);
  });

  test("a missing reusable workflow is one file; a stem outside actions/ is asked for a manifest like any directory", () => {
    const pins = [
      { file: "a", stem: "repo-platform/.github/workflows/reusable-ghost.yml", ref: "stable" },
      { file: "b", stem: "repo-platform/scripts/run_tests.ts", ref: "stable" },
    ];
    expect(stemMismatches(pins, exists)).toEqual([
      {
        file: "a",
        expected: missing(".github/workflows/reusable-ghost.yml"),
        got: "repo-platform/.github/workflows/reusable-ghost.yml@stable (no such path)",
      },
      {
        file: "b",
        expected: missing("scripts/run_tests.ts/action.yml or scripts/run_tests.ts/action.yaml"),
        got: "repo-platform/scripts/run_tests.ts@stable (no such path)",
      },
    ]);
  });

  test("an empty scan throws - anchor lost, never a silently green rule", () => {
    expect(() => stemMismatches([], exists)).toThrow("anchor lost");
  });
});
