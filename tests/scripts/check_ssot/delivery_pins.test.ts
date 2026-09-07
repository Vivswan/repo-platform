// The delivery-pin rules' pure helpers (scripts/check/ssot/delivery_pins.ts).

import { describe, expect, test } from "bun:test";
import type { Mismatch } from "../../../scripts/check/ssot/comparison.ts";
import {
  deliveryRefMismatches,
  deliveryRefTwinMismatches,
  extractUsesPins,
  fleetWorkflowPinMismatches,
  hookCommandParts,
  type Pin,
  pinMismatches,
  renderedSelfPins,
  STAMP_HOOK_ARGV,
  STAMP_HOOK_WHEN,
  stampHookSiteMismatches,
  templateSelfPins,
} from "../../../scripts/check/ssot/delivery_pins.ts";

describe("extractUsesPins", () => {
  const text = [
    "      - uses: actions/checkout@v7",
    "      # - uses: astral-sh/setup-uv@v7",
    "      - uses: ./actions/check-typography",
    "    uses: {{ github_username }}/repo-platform/actions/x@{{ uses_ref }}",
    "    uses: github/codeql-action/init@v4",
  ].join("\n");

  test("extracts real pins, commented examples included; local and jinja-ref lines are skipped", () => {
    const pins = extractUsesPins(text, "f");
    expect(pins.map((p) => `${p.action}@${p.ref}`)).toEqual([
      "actions/checkout@v7",
      "astral-sh/setup-uv@v7",
      "github/codeql-action@v4",
    ]);
  });

  test("extracts quoted pins", () => {
    const pins = extractUsesPins('      - uses: "actions/checkout@v8"', "f");
    expect(pins.map((p) => `${p.action}@${p.ref}`)).toEqual(["actions/checkout@v8"]);
  });
});

describe("pinMismatches", () => {
  const split = [
    { file: "a.yml", action: "x/y", ref: "v1" },
    { file: "b.yml", action: "x/y", ref: "v2" },
  ];

  test("passes when every action maps to one ref", () => {
    expect(pinMismatches([{ file: "a.yml", action: "x/y", ref: "v1" }], {})).toEqual([]);
  });

  test("flags an action pinned at two refs, naming the sites", () => {
    expect(pinMismatches(split, {})).toEqual([
      { file: "x/y", expected: "a single pinned ref", got: "v1 (a.yml); v2 (b.yml)" },
    ]);
  });

  test("honors an allowlisted split whose ref set matches exactly", () => {
    expect(pinMismatches(split, { "x/y": ["v1", "v2"] })).toEqual([]);
  });

  test.each<{
    reason: string;
    pins: Pin[];
    expected: Mismatch;
    allowed: Record<string, string[]>;
  }>([
    {
      reason: "the allowlisted ref set differs from the pinned one",
      pins: split,
      expected: { file: "x/y", expected: "the allowlisted refs [v1, v3]", got: "v1, v2" },
      allowed: { "x/y": ["v1", "v3"] },
    },
    {
      reason: "a stale allowlist entry whose split collapsed to one ref",
      pins: [{ file: "a.yml", action: "x/y", ref: "v1" }],
      expected: { file: "x/y", expected: "the allowlisted refs [v1, v2]", got: "v1" },
      allowed: { "x/y": ["v1", "v2"] },
    },
    {
      reason: "a stale allowlist entry whose action has no pins at all",
      pins: [],
      expected: {
        file: "x/y",
        expected: "an action still pinned somewhere (allowlisted)",
        got: "no uses: pins found (stale allowlist entry - remove it)",
      },
      allowed: { "x/y": ["v1", "v2"] },
    },
  ])("flags $reason, naming the drift", ({ pins, allowed, expected }) => {
    expect(pinMismatches(pins, allowed)).toEqual([expected]);
  });
});

describe("renderedSelfPins and deliveryRefMismatches (fleet-refs-ride-build)", () => {
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

  test("extracts rendered delivery pins - actions and reusable workflows alike", () => {
    const text = [
      "      - uses: Vivswan/repo-platform/actions/fuzz-issue@build",
      "    uses: Vivswan/repo-platform/.github/workflows/reusable-pages.yml@main",
    ].join("\n");
    expect(renderedSelfPins(text, "f", "Vivswan")).toEqual([
      { file: "f", stem: "repo-platform/actions/fuzz-issue", ref: "build" },
      { file: "f", stem: "repo-platform/.github/workflows/reusable-pages.yml", ref: "main" },
    ]);
  });

  test("third-party, local, other-repo, and longer-owner refs are not self-pins", () => {
    const text = [
      "      - uses: actions/checkout@v7",
      "      - uses: ./actions/local",
      "      - uses: Vivswan/other-repo/actions/x@main",
      "      - uses: EvilVivswan/repo-platform/actions/x@main",
    ].join("\n");
    expect(renderedSelfPins(text, "f", "Vivswan")).toEqual([]);
  });

  test("an owner that is not a plain username throws rather than riding the regex", () => {
    expect(() => renderedSelfPins("", "f", "a.b|c")).toThrow("not a plain GitHub username");
  });

  test("a planted @main template ref reds, naming the file and the offending ref", () => {
    const planted =
      "    uses: {{ github_username }}/repo-platform/.github/workflows/reusable-pages.yml@main";
    const file = "templates/pages/.github/workflows/pages.yml.jinja";
    const mismatches = deliveryRefMismatches(templateSelfPins(planted, file), "build");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].file).toBe(file);
    expect(mismatches[0].expected).toContain(
      "repo-platform/.github/workflows/reusable-pages.yml@build",
    );
    expect(mismatches[0].got).toBe("@main");
    // Restored to the delivery ref, the same content is green.
    const restored = planted.replace("@main", "@build");
    expect(deliveryRefMismatches(templateSelfPins(restored, file), "build")).toEqual([]);
  });

  test("a planted @main golden-render ref reds the same way", () => {
    const planted = "    uses: Vivswan/repo-platform/.github/workflows/reusable-pages.yml@main";
    const file = "tests/golden-renders/all-modules/.github/workflows/pages.yml";
    const mismatches = deliveryRefMismatches(renderedSelfPins(planted, file, "Vivswan"), "build");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].file).toBe(file);
    expect(mismatches[0].got).toBe("@main");
    expect(
      deliveryRefMismatches(
        renderedSelfPins(planted.replace("@main", "@build"), file, "Vivswan"),
        "build",
      ),
    ).toEqual([]);
  });

  test("any non-delivery ref reds, not just @main - a tag or sha forks the channel too", () => {
    const pins = [{ file: "f", stem: "repo-platform/actions/x", ref: "v2" }];
    expect(deliveryRefMismatches(pins, "build")[0].got).toBe("@v2");
  });

  test("the lowered-username spelling is scanned too - `| lower` renders a working owner", () => {
    const planted =
      "    uses: {{ github_username | lower }}/repo-platform/.github/workflows/reusable-pages.yml@main";
    const pins = templateSelfPins(planted, "f");
    expect(pins).toEqual([
      { file: "f", stem: "repo-platform/.github/workflows/reusable-pages.yml", ref: "main" },
    ]);
    expect(deliveryRefMismatches(pins, "build")).toHaveLength(1);
    // The expression slot is matched wholesale, not by enumerating
    // spellings: filter-call and whitespace-control forms render the same
    // working owner and must be caught too.
    for (const expression of [
      "{{ github_username }}",
      "{{ github_username | lower() }}",
      "{{- github_username -}}",
    ]) {
      expect(templateSelfPins(`uses: ${expression}/repo-platform/actions/x@main`, "f")).toEqual([
        { file: "f", stem: "repo-platform/actions/x", ref: "main" },
      ]);
    }
    // Another owner's expression is not a self-pin.
    expect(templateSelfPins("uses: {{ other_owner }}/repo-platform/actions/x@main", "f")).toEqual(
      [],
    );
  });

  test("a rendered case-variant owner or repo is scanned and stem-normalized", () => {
    const pins = renderedSelfPins("    uses: vivswan/Repo-Platform/actions/x@main", "f", "Vivswan");
    // The stem's repo prefix comes back canonical, so the roster coupling
    // below cannot be dodged by a case-variant repo name.
    expect(pins).toEqual([{ file: "f", stem: "repo-platform/actions/x", ref: "main" }]);
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

describe("hookCommandParts", () => {
  const script = "{{ _copier_conf.src_path }}/actions/shared/stamp_manifest.ts";
  test.each([
    {
      command: ["bun", script, ...STAMP_HOOK_ARGV],
      expected: {
        path: "actions/shared/stamp_manifest.ts",
        args: [...STAMP_HOOK_ARGV],
        form: "argv",
      },
    },
    {
      command: ["bun", script],
      expected: { path: "actions/shared/stamp_manifest.ts", args: [], form: "argv" },
    },
    {
      command: `bun "${script}" --flag x`,
      expected: { path: "actions/shared/stamp_manifest.ts", args: ["--flag", "x"], form: "shell" },
    },
    {
      command: 'bun "{{ _copier_conf.src_path }}/actions/other/task.ts"',
      expected: { path: "actions/other/task.ts", args: [], form: "shell" },
    },
  ])("$command", ({ command, expected }) => {
    expect(hookCommandParts(command)).toEqual(expected);
  });

  test("a hook that is not the src_path-anchored bun shape is a lost anchor", () => {
    for (const command of [
      "bun actions/shared/stamp_manifest.ts",
      `python "{{ _copier_conf.src_path }}/x.py"`,
      ["python", `{{ _copier_conf.src_path }}/x.py`],
      ["bun", "actions/shared/stamp_manifest.ts"],
      ["bun"],
    ]) {
      expect(() => hookCommandParts(command)).toThrow(
        "anchor for a src_path-anchored bun hook command",
      );
    }
  });
});

describe("stampHookSiteMismatches", () => {
  const STAMP = "actions/shared/stamp_manifest.ts";
  const script = `{{ _copier_conf.src_path }}/${STAMP}`;
  const good = { command: ["bun", script, ...STAMP_HOOK_ARGV], when: STAMP_HOOK_WHEN._tasks };
  const other = { command: 'bun "{{ _copier_conf.src_path }}/actions/other/task.ts"', when: "" };
  const without = (flag: string) => {
    const i = STAMP_HOOK_ARGV.indexOf(flag as (typeof STAMP_HOOK_ARGV)[number]);
    return ["bun", script, ...STAMP_HOOK_ARGV.slice(0, i), ...STAMP_HOOK_ARGV.slice(i + 2)];
  };
  const gotOf = (hooks: { command: string | readonly string[]; when: string }[]) =>
    stampHookSiteMismatches("_tasks", hooks, STAMP).map((m) => `${m.expected} | ${m.got}`);

  test("the wired shape passes, other hooks beside it are ignored", () => {
    expect(gotOf([good])).toEqual([]);
    expect(gotOf([other, good])).toEqual([]);
  });

  test.each<{ reason: string; hooks: Parameters<typeof gotOf>[0]; expected: string }>([
    { reason: "no stamp hook", hooks: [other], expected: "none - renders on that path" },
    { reason: "a duplicate stamp hook", hooks: [good, good], expected: "2 stamp hooks" },
    {
      reason: "missing when",
      hooks: [{ ...good, when: "" }],
      expected: "no when (the destination would be stamped twice on update)",
    },
    {
      reason: "the other site's when",
      hooks: [{ ...good, when: STAMP_HOOK_WHEN._migrations }],
      expected: `when: "${STAMP_HOOK_WHEN._migrations}"`,
    },
    {
      reason: "missing --root",
      hooks: [{ ...good, command: without("--root") }],
      expected: "carrying",
    },
    {
      reason: "missing --commit",
      hooks: [{ ...good, command: without("--commit") }],
      expected: "carrying",
    },
    {
      reason: "missing --answers",
      hooks: [{ ...good, command: without("--answers") }],
      expected: "carrying",
    },
    {
      reason: "dst_path instead of . for the root",
      hooks: [
        {
          ...good,
          command: [
            "bun",
            script,
            "--root",
            "{{ _copier_conf.dst_path }}",
            ...STAMP_HOOK_ARGV.slice(2),
          ],
        },
      ],
      expected: '"{{ _copier_conf.dst_path }}"',
    },
    {
      reason: "no arguments at all",
      hooks: [{ ...good, command: ["bun", script] }],
      expected: "no arguments",
    },
  ])("$reason -> a named mismatch", ({ hooks, expected }) => {
    const got = gotOf(hooks);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain(expected);
  });

  test("the shell-string form is refused even with the right arguments (injection surface)", () => {
    const shell = {
      ...good,
      command: `bun "${script}" ${STAMP_HOOK_ARGV.map((a) => (a.startsWith("--") || a === "." ? a : `"${a}"`)).join(" ")}`,
    };
    const got = gotOf([shell]);
    expect(got.some((line) => line.includes("a shell string"))).toBe(true);
  });

  test("the migrations site is judged against its own when", () => {
    const hook = { command: good.command, when: STAMP_HOOK_WHEN._migrations };
    expect(stampHookSiteMismatches("_migrations", [hook], STAMP)).toEqual([]);
    expect(stampHookSiteMismatches("_migrations", [good], STAMP)).toHaveLength(1);
  });
});
