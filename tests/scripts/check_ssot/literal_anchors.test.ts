// The literal-anchor rules' pure helpers (scripts/check/ssot/literal_anchors.ts).

import { describe, expect, test } from "bun:test";
import {
  inlineFunctionCopies,
  isOwnPagesOrigin,
  releaseCutWiringMismatches,
} from "../../../scripts/check/ssot/literal_anchors.ts";

describe("inlineFunctionCopies", () => {
  const copy = (indent: string, body: string) =>
    [
      `${indent}async function resolve() {`,
      `${indent}  if (x) {`,
      `${indent}    ${body}`,
      `${indent}  }`,
      `${indent}}`,
    ].join("\n");

  test.each([
    { indent: "    ", reason: "four-space indent" },
    { indent: "  ", reason: "two-space indent - the nested close brace sits at indent+2" },
  ])(
    "extracts every copy byte-exactly, closing at the declaration's own indent ($reason)",
    ({ indent }) => {
      // Three copies, two of them identical, compared as an exact list: this
      // covers the early-close path (a nested `}` would truncate a copy),
      // body fidelity (a dropped byte would compare unequal), that each copy
      // carries its own bytes rather than the first one's, and that
      // identical copies are all kept (a deduplicating extractor fails).
      const a = copy(indent, "a();");
      const b = copy(indent, "b();");
      expect(inlineFunctionCopies(`head\n${a}\ntail\n${b}\n${a}\n`, "resolve")).toEqual([a, b, a]);
    },
  );

  test("returns nothing when the function is absent, so rules can fail loudly", () => {
    expect(inlineFunctionCopies("const resolve = 1;", "resolve")).toEqual([]);
  });
});

describe("isOwnPagesOrigin", () => {
  const at = (text: string) => text.indexOf("io/repo-platform");

  test("accepts this owner's Pages origin, hostname-boundary anchored", () => {
    const url = "see https://vivswan.github.io/repo-platform/ for the site";
    expect(isOwnPagesOrigin(url, at(url), "io", "Vivswan")).toBe(true);
    const bare = "vivswan.github.io/repo-platform";
    expect(isOwnPagesOrigin(bare, at(bare), "io", "Vivswan")).toBe(true);
    // Hostnames are case-insensitive; the answer casing must not matter.
    const cased = "Vivswan.GitHub.io/repo-platform";
    expect(isOwnPagesOrigin(cased, at(cased), "io", "vivswan")).toBe(true);
    // ... the io segment's own casing included.
    const casedIo = "vivswan.github.IO/repo-platform";
    expect(isOwnPagesOrigin(casedIo, casedIo.indexOf("IO/"), "IO", "Vivswan")).toBe(true);
  });

  test("rejects every other owner, the username-suffixed near miss included", () => {
    // A plain endsWith would exempt an owner whose name merely ENDS with
    // the username; the boundary check exists for this case.
    const nearMiss = "https://notvivswan.github.io/repo-platform/";
    expect(isOwnPagesOrigin(nearMiss, at(nearMiss), "io", "Vivswan")).toBe(false);
    const otherOwner = "https://someone.github.io/repo-platform/";
    expect(isOwnPagesOrigin(otherOwner, at(otherOwner), "io", "Vivswan")).toBe(false);
    // A subdomain of the origin is not the origin either.
    const subdomain = "https://other.vivswan.github.io/repo-platform/";
    expect(isOwnPagesOrigin(subdomain, at(subdomain), "io", "Vivswan")).toBe(false);
    const bareIo = "evil.io/repo-platform";
    expect(isOwnPagesOrigin(bareIo, at(bareIo), "io", "Vivswan")).toBe(false);
    // Only the io segment is ever a Pages origin.
    expect(isOwnPagesOrigin("x/repo-platform", 0, "x", "Vivswan")).toBe(false);
  });
});

describe("releaseCutWiringMismatches", () => {
  // The three files as wired, reduced to the keys the rule reads.
  const workflow = (
    skip = "${{ steps.health.outputs.release-cut != 'true' }}",
    healthId = "health",
    mode = "release",
  ) => `
jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: Vivswan/repo-platform/actions/release-health@build
        id: ${healthId}
        with:
          mode: ${mode}
      - uses: googleapis/release-please-action@sha # v5.0.0
        id: release
        with:
          token: \${{ github.token }}
          skip-github-release: ${skip}
`;
  const action = (value = "${{ steps.check.outputs.release-cut }}", stepId = "check") => `
name: Release Health
outputs:
  release-cut:
    value: ${value}
runs:
  using: composite
  steps:
    - name: Check release health
      id: ${stepId}
      shell: bash
      run: '"$ACTION_BUN" "\${{ github.action_path }}/release-health.ts"'
`;
  const script = (write = 'setOutput("release-cut", pr === undefined ? "false" : "true");') =>
    `if (cfg.context.mode === "release") {\n  ${write}\n}\n`;
  const wired = { workflow: workflow(), action: action(), script: script() };

  test("the wiring as shipped yields nothing (the control)", () => {
    expect(releaseCutWiringMismatches(wired)).toEqual([]);
  });

  const drifts = [
    {
      reason: "the workflow stops passing skip-github-release, so every push run tags",
      files: { ...wired, workflow: workflow("") },
      expected: {
        file: ".github/workflows/fleet-release.yml release-please step 'release'",
        expected: "skip-github-release: ${{ steps.health.outputs.release-cut != 'true' }}",
        got: "no skip-github-release input",
      },
    },
    {
      reason:
        "the health step loses the id the expression reads (an empty output is not 'true', so every run skips)",
      files: { ...wired, workflow: workflow(undefined, "gate") },
      expected: {
        file: ".github/workflows/fleet-release.yml release-please",
        expected: "the release-health step carries id: health",
        got: "id: gate",
      },
    },
    {
      reason:
        "the health step runs in pull-request mode, which never writes release-cut (the id and the expression still line up, so only the mode pin sees it)",
      files: { ...wired, workflow: workflow(undefined, undefined, "pull-request") },
      expected: {
        file: ".github/workflows/fleet-release.yml release-please step 'health'",
        expected: "mode: release",
        got: "mode: pull-request",
      },
    },
    {
      reason: "the action renames the output",
      files: { ...wired, action: action().replace("release-cut:", "is-release-cut:") },
      expected: {
        file: "actions/release-health/action.yml outputs.release-cut",
        expected: "${{ steps.check.outputs.release-cut }}",
        got: "no such output",
      },
    },
    {
      reason: "the action's script step loses the id its output reads",
      files: { ...wired, action: action(undefined, "run") },
      expected: {
        file: "actions/release-health/action.yml runs.steps",
        expected: "the step running release-health.ts carries id: check",
        got: "no such step",
      },
    },
    {
      reason: "the script's write is commented out (a whole-file grep would still see it)",
      files: { ...wired, script: script('// setOutput("release-cut", "true");') },
      expected: {
        file: "actions/release-health/release-health.ts",
        expected: 'a setOutput("release-cut", ...) write in release mode',
        got: "no such write",
      },
    },
  ];
  test.each(drifts)("$reason", ({ files, expected }) => {
    expect(releaseCutWiringMismatches(files)).toEqual([expected]);
  });
});
