import { describe, expect, test } from "bun:test";
import type { Mismatch } from "../../../scripts/check/ssot/comparison.ts";
import {
  AUTOMATION_PR_ACTION,
  automationPrIdentityMismatches,
  inlineFunctionCopies,
  isOwnPagesOrigin,
  platformNameLiteralMismatches,
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
      // Two of the three copies are identical, so a deduplicating extractor fails the exact list.
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
    const subdomain = "https://other.vivswan.github.io/repo-platform/";
    expect(isOwnPagesOrigin(subdomain, at(subdomain), "io", "Vivswan")).toBe(false);
    const bareIo = "evil.io/repo-platform";
    expect(isOwnPagesOrigin(bareIo, at(bareIo), "io", "Vivswan")).toBe(false);
    // Only the io segment is ever a Pages origin.
    expect(isOwnPagesOrigin("x/repo-platform", 0, "x", "Vivswan")).toBe(false);
  });
});

describe("releaseCutWiringMismatches", () => {
  const workflow = ({
    healthId = "health",
    mode = "release",
    cutIf = "steps.health.outputs.release-cut == 'true'",
    cutWith = "skip-github-pull-request: true",
    proposeIf = "steps.health.outputs.release-cut == 'false' && steps.head.outputs.current == 'true'",
    proposeWith = "skip-github-release: true",
    lane = "release-cut-${{ inputs.sha || github.sha }}",
    cancel = "false",
    extra = "",
  } = {}) => `
jobs:
  release-please:
    runs-on: ubuntu-latest
    concurrency:
      group: ${lane}
      cancel-in-progress: ${cancel}
    steps:
      - uses: Vivswan/repo-platform/actions/release-health@stable
        id: ${healthId}
        with:
          mode: ${mode}
      - uses: googleapis/release-please-action@sha # v5.0.0
        id: cut
        ${cutIf === "" ? "" : `if: ${cutIf}`}
        with:
          token: \${{ github.token }}
          ${cutWith}
      - uses: googleapis/release-please-action@sha # v5.0.0
        id: propose
        ${proposeIf === "" ? "" : `if: ${proposeIf}`}
        with:
          token: \${{ github.token }}
          ${proposeWith}
${extra}`;
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
  const skeleton = (lane = "") => `
jobs:
  release:
    needs: [ci, all-green, post-green]
${lane}
    uses: {{github_username}}/repo-platform/.github/workflows/fleet-release.yml@stable
`;
  const wired = { workflow: workflow(), action: action(), script: script(), skeleton: skeleton() };

  test("the wiring as shipped yields nothing (the control)", () => {
    expect(releaseCutWiringMismatches(wired)).toEqual([]);
  });

  const cutSite = ".github/workflows/fleet-release.yml release-please step 'cut'";
  const proposeSite = ".github/workflows/fleet-release.yml release-please step 'propose'";
  const drifts = [
    {
      reason: "the cut step loses its condition, so every push run tags",
      files: { ...wired, workflow: workflow({ cutIf: "" }) },
      expected: {
        file: cutSite,
        expected: "if: steps.health.outputs.release-cut == 'true'",
        got: "no condition",
      },
    },
    {
      reason:
        "the cut step starts doing PR work too (two runs would race the release-please branch)",
      files: { ...wired, workflow: workflow({ cutWith: "skip-github-release: false" }) },
      expected: {
        file: cutSite,
        expected:
          "skip-github-pull-request: true and no skip-github-release (the cut tags and does no PR work)",
        got: '{"skip-github-release":false,"token":"${{ github.token }}"}',
      },
    },
    {
      reason: "the propose step drops its release-cut clause, so a release merge runs both steps",
      files: {
        ...wired,
        workflow: workflow({ proposeIf: "steps.head.outputs.current == 'true'" }),
      },
      expected: {
        file: proposeSite,
        expected:
          "an if: carrying steps.health.outputs.release-cut == 'false' (the propose step stands down on a release-PR merge; a positive test, since an absent output passes !=)",
        got: "steps.head.outputs.current == 'true'",
      },
    },
    {
      reason: "the propose step stops passing skip-github-release, so every push run tags",
      files: { ...wired, workflow: workflow({ proposeWith: "skip-labeling: false" }) },
      expected: {
        file: proposeSite,
        expected: "skip-github-release: true (the propose step never tags)",
        got: '{"skip-labeling":false,"token":"${{ github.token }}"}',
      },
    },
    {
      reason: "a third release-please step with no condition tags on every push run",
      files: {
        ...wired,
        workflow: workflow({
          extra:
            "      - uses: googleapis/release-please-action@sha # v5.0.0\n        id: release\n",
        }),
      },
      expected: {
        file: ".github/workflows/fleet-release.yml release-please",
        expected:
          "every release-please step is the cut or the propose step (a third one would tag on every push run)",
        got: "a release-please step with id: release",
      },
    },
    {
      reason: "the job lane is keyed by something runs share, so a pending cut can be cancelled",
      files: { ...wired, workflow: workflow({ lane: "post-green-release" }) },
      expected: {
        file: ".github/workflows/fleet-release.yml release-please",
        expected:
          "concurrency group release-cut-${{ inputs.sha || github.sha }} with cancel-in-progress: false (a lane no other run shares, so nothing cancels a pending cut)",
        got: '{"cancel-in-progress":false,"group":"post-green-release"}',
      },
    },
    {
      reason: "the job lane cancels in progress",
      files: { ...wired, workflow: workflow({ cancel: "true" }) },
      expected: {
        file: ".github/workflows/fleet-release.yml release-please",
        expected:
          "concurrency group release-cut-${{ inputs.sha || github.sha }} with cancel-in-progress: false (a lane no other run shares, so nothing cancels a pending cut)",
        got: '{"cancel-in-progress":true,"group":"release-cut-${{ inputs.sha || github.sha }}"}',
      },
    },
    {
      reason:
        "the health step loses the id the expression reads (an empty output is not 'true', so every run skips)",
      files: { ...wired, workflow: workflow({ healthId: "gate" }) },
      expected: {
        file: ".github/workflows/fleet-release.yml release-please",
        expected: "the release-health step carries id: health",
        got: "id: gate",
      },
    },
    {
      reason:
        "the health step runs in pull-request mode, which never writes release-cut (the id and the expression still line up, so only the mode pin sees it)",
      files: { ...wired, workflow: workflow({ mode: "pull-request" }) },
      expected: {
        file: ".github/workflows/fleet-release.yml release-please step 'health'",
        expected: "mode: release",
        got: "mode: pull-request",
      },
    },
    {
      reason: "the skeleton's caller takes a lane back, so a pending release call can be cancelled",
      files: {
        ...wired,
        skeleton: skeleton(
          "    concurrency:\n      group: post-green-release\n      cancel-in-progress: false",
        ),
      },
      expected: {
        file: "files/base/.github/workflows/ci.yml job 'release'",
        expected:
          "no concurrency lane on the caller (a caller-side lane keeps one pending call and cancels the older one, so a release merge would lose its tag)",
        got: '{"cancel-in-progress":false,"group":"post-green-release"}',
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

describe("platformNameLiteralMismatches", () => {
  const imported = [
    'import { PLATFORM_NAME } from "../shared/platform.ts";',
    "const branch = `automation/${PLATFORM_NAME}`;",
    '"skills/repo-platform-sync-pr/references/file-ownership.md",',
    `'{"site_title": "repo-platform", "docs_path": "docs"}'`,
    'const token = requireEnv("REPO_PLATFORM_TOKEN");',
  ].join("\n");

  test("imported spellings and the two allowed literal forms yield nothing (the control)", () => {
    expect(platformNameLiteralMismatches({ "scripts/a.ts": imported })).toEqual([]);
  });

  test("a literal in a string, a comment, or a hand-built marker names its file and line", () => {
    const drifted = [
      'export const BRANCH = "automation/repo-platform";',
      "// pushed by Vivswan/repo-platform",
      'const begin = "# BEGIN REPO-PLATFORM MANAGED";',
      "const fine = PLATFORM_NAME;",
    ].join("\n");
    expect(
      platformNameLiteralMismatches({ "scripts/a.ts": imported, "actions/b.ts": drifted }),
    ).toEqual([
      {
        file: "actions/b.ts:1",
        expected: "the platform's name imported from actions/shared/platform.ts",
        got: 'export const BRANCH = "automation/repo-platform";',
      },
      {
        file: "actions/b.ts:2",
        expected: "the platform's name imported from actions/shared/platform.ts",
        got: "// pushed by Vivswan/repo-platform",
      },
      {
        file: "actions/b.ts:3",
        expected: "the platform's name imported from actions/shared/platform.ts",
        got: 'const begin = "# BEGIN REPO-PLATFORM MANAGED";',
      },
    ]);
  });
});

describe("automationPrIdentityMismatches", () => {
  const identity = { name: "bot", email: "bot@example.invalid" };
  const signature = "bot <bot@example.invalid>";
  const workflow = (inputs: Record<string, string>) =>
    [
      "jobs:",
      "  refresh:",
      "    steps:",
      "      - run: bun regenerate.ts",
      "      - name: Commit, push, and open PR",
      `        uses: ${AUTOMATION_PR_ACTION}@0000000000000000000000000000000000000000 # v8.1.1`,
      "        with:",
      "          branch: automation/x-refresh",
      ...Object.entries(inputs).map(([key, value]) => `          ${key}: ${value}`),
      "",
    ].join("\n");
  const REL = ".github/workflows/refresh-x.yml";

  const rows: { reason: string; inputs: Record<string, string>; mismatches: Mismatch[] }[] = [
    {
      reason: "both inputs spelling the identity yield nothing (the control)",
      inputs: { committer: signature, author: signature },
      mismatches: [],
    },
    {
      reason: "a missing author and a misspelled committer are each named",
      inputs: { committer: "bot <bot@users.noreply.github.com>" },
      mismatches: [
        {
          file: `${REL} step "Commit, push, and open PR"`,
          expected: `with.committer: ${signature}`,
          got: "with.committer: bot <bot@users.noreply.github.com>",
        },
        {
          file: `${REL} step "Commit, push, and open PR"`,
          expected: `with.author: ${signature}`,
          got: "no author: on the step",
        },
      ],
    },
  ];

  test.each(rows)("$reason", ({ inputs, mismatches }) => {
    // A second workflow with no such step is never judged and never
    // counts toward the anchor.
    const files = { [REL]: workflow(inputs), ".github/workflows/ci.yml": "jobs: {}\n" };
    expect(automationPrIdentityMismatches(files, identity)).toEqual(mismatches);
  });

  test("no step anywhere is a lost anchor, not a clean tree", () => {
    expect(() =>
      automationPrIdentityMismatches({ ".github/workflows/ci.yml": "jobs: {}\n" }, identity),
    ).toThrow(`no ${AUTOMATION_PR_ACTION} step in any workflow - anchor lost`);
  });
});
