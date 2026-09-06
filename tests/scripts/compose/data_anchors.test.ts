// Unit tests for the composer's data-anchor derivations: value grouping
// and or-chain gate rendering - covering the future shapes (two modules
// sharing a CodeQL language, a dependabot label, or a lockfile pattern)
// that the sharing rule must emit once behind an or-chain gate.

import { describe, expect, test } from "bun:test";
import {
  agentsToolchainErrors,
  applyToolchainSetup,
  codeqlGroups,
  dependabotLabels,
  ecosystemGroups,
  lockfileGroups,
  orChain,
  renderedSeparationErrors,
} from "../../../scripts/compose/data_anchors";
import type { ModuleManifest } from "../../../scripts/lib/module_manifests";
import { AGENTS, BUN, manifest, NODE, UV } from "./fixtures";

function gateOfFor(manifests: ModuleManifest[]): (module: string) => string {
  const gates = new Map(manifests.map((m) => [m.module, m.gate ?? `'${m.module}' in modules`]));
  return (module) => {
    const gate = gates.get(module);
    if (gate === undefined) throw new Error(`no gate for '${module}'`);
    return gate;
  };
}

describe("orChain", () => {
  const gateOf = gateOfFor([BUN, NODE]);

  test.each([
    {
      reason: "a single module renders its own gate",
      modules: ["bun"],
      gateOf,
      expected: "'bun' in modules",
    },
    {
      reason: "several modules chain their gates with 'or' in the given order",
      modules: ["bun", "node"],
      gateOf,
      expected: "'bun' in modules or 'node' in modules",
    },
    {
      reason: "a custom manifest gate participates verbatim",
      modules: ["demo", "other"],
      gateOf: gateOfFor([manifest("demo", ["gate: not private"]), manifest("other", [])]),
      expected: "not private or 'other' in modules",
    },
  ])("$reason", ({ modules, gateOf: gates, expected }) => {
    expect(orChain(modules, gates)).toBe(expected);
  });

  test("an unknown module fails loudly instead of guessing a gate", () => {
    expect(() => orChain(["ghost"], gateOf)).toThrow("ghost");
  });
});

describe("applyToolchainSetup", () => {
  const fragmentMap = (entries: [ModuleManifest, string][][]) => {
    const map = new Map<string, [ModuleManifest, Buffer][]>();
    const names = ["toolchain-setup", "auto-format", "copilot-setup-steps"];
    entries.forEach((list, index) => {
      if (list.length > 0) {
        map.set(
          names[index],
          list.map(([m, body]) => [m, Buffer.from(body)]),
        );
      }
    });
    return map;
  };

  test("the setup steps are prepended to both targets and the entry is consumed", () => {
    const map = fragmentMap([
      [[BUN, "\n- setup\n"]],
      [
        [BUN, "- format\n"],
        [UV, "- ruff\n"],
      ],
      [[BUN, "- install\n"]],
    ]);
    expect(applyToolchainSetup(map)).toEqual([]);
    expect(map.has("toolchain-setup")).toBe(false);
    const bodies = (anchor: string) =>
      (map.get(anchor) ?? []).map(([m, body]) => [m.module, body.toString("utf-8")]);
    expect(bodies("auto-format")).toEqual([
      ["bun", "\n- setup\n- format\n"],
      ["uv", "- ruff\n"],
    ]);
    expect(bodies("copilot-setup-steps")).toEqual([["bun", "\n- setup\n- install\n"]]);
  });

  test("setup steps without both target fragments error instead of half-applying", () => {
    const map = fragmentMap([[[BUN, "- setup\n"]], [[BUN, "- format\n"]], []]);
    const errors = applyToolchainSetup(map);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("templates/bun/fragments/toolchain-setup.jinja");
    expect(errors[0]).toContain("copilot-setup-steps");
  });

  test("setup steps not ending with a newline error instead of fusing lines", () => {
    const map = fragmentMap([[[BUN, "- setup"]], [[BUN, "- format\n"]], [[BUN, "- install\n"]]]);
    const errors = applyToolchainSetup(map);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("end with a newline");
    expect(map.get("auto-format")?.[0][1].toString("utf-8")).toBe("- format\n");
  });

  test("both target fragments without setup steps error - that duplication is the rule's point", () => {
    const map = fragmentMap([[], [[BUN, "- format\n"]], [[BUN, "- install\n"]]]);
    const errors = applyToolchainSetup(map);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("hoist the shared setup steps");
  });
});

describe("ecosystemGroups", () => {
  test("distinct ecosystems each form their own group, non-dependabot modules skipped", () => {
    expect(ecosystemGroups([AGENTS, BUN, NODE, UV])).toEqual([
      { ecosystem: "bun", modules: ["bun"] },
      { ecosystem: "npm", modules: ["node"] },
      { ecosystem: "uv", modules: ["uv"] },
    ]);
  });
});

describe("codeqlGroups", () => {
  test("modules sharing a language collapse into one group in order", () => {
    expect(codeqlGroups([AGENTS, BUN, NODE, UV])).toEqual([
      { language: "javascript-typescript", modules: ["bun", "node"] },
      { language: "python", modules: ["uv"] },
    ]);
  });
});

describe("dependabotLabels", () => {
  test("modules sharing a label collapse into one entry with the shared tuple", () => {
    expect(dependabotLabels([BUN, NODE, UV])).toEqual([
      {
        name: "javascript",
        color: "168700",
        description: "Pull requests that update javascript code",
        modules: ["bun", "node"],
      },
      {
        name: "python:uv",
        color: "2b67c6",
        description: "Pull requests that update python:uv code",
        modules: ["uv"],
      },
    ]);
  });
});

describe("agentsToolchainErrors", () => {
  const codeqlOnly = manifest("zig", ["toolchain: {codeql_language: c-cpp}"]);
  const dependabotOnly = manifest("cargo", [
    'dependabot: {ecosystem: cargo, label: rust, color: "dea584"}',
  ]);

  test("passes when every dependabot/toolchain module ships its fragment", () => {
    expect(
      agentsToolchainErrors(
        [AGENTS, BUN, codeqlOnly, dependabotOnly],
        new Set(["bun", "zig", "cargo"]),
      ),
    ).toEqual([]);
  });

  test("a module declaring neither dependabot nor a toolchain needs no fragment", () => {
    expect(agentsToolchainErrors([AGENTS], new Set())).toEqual([]);
  });

  test.each([
    { reason: "a dependabot-only module", manifest: dependabotOnly, declares: "dependabot" },
    {
      reason: "a toolchain-only module (codeql-only shape)",
      manifest: codeqlOnly,
      declares: "a toolchain",
    },
    {
      reason: "a module declaring both names both",
      manifest: BUN,
      declares: "dependabot and a toolchain",
    },
  ])(
    "$reason without the fragment errors, naming what it declares",
    ({ manifest: m, declares }) => {
      expect(agentsToolchainErrors([m], new Set())).toEqual([
        `templates/${m.module}/module.yml declares ${declares} but ` +
          `templates/${m.module}/fragments/agents-toolchain.jinja is missing - AGENTS.md's ` +
          "Toolchain section would silently skip the module; add the fragment with its " +
          "toolchain bullets",
      ]);
    },
  );
});

describe("renderedSeparationErrors", () => {
  const wrapped = (gate: string, body: string) => Buffer.from(`{% if ${gate} %}${body}{% endif %}`);

  test("a non-last gate-wrapped contribution without a trailing newline errors loudly", () => {
    const errors = renderedSeparationErrors("demo", [
      {
        source: "templates/a/fragments/demo.jinja",
        text: wrapped("'a' in modules", "      - a-job"),
      },
      {
        source: "templates/b/fragments/demo.jinja",
        text: wrapped("'b' in modules", "      - b-job"),
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("templates/a/fragments/demo.jinja");
    expect(errors[0]).toContain("end the fragment body with a newline");
  });

  test("the same contributions pass once the inner bodies end with a newline", () => {
    expect(
      renderedSeparationErrors("demo", [
        { source: "a", text: wrapped("'a' in modules", "      - a-job\n") },
        { source: "b", text: wrapped("'b' in modules", "      - b-job\n") },
      ]),
    ).toEqual([]);
  });

  test("several trailing closing tags are stripped before the check", () => {
    expect(
      renderedSeparationErrors("demo", [
        {
          source: "a",
          text: Buffer.from("{% if x %}{% if y %}body\n{% endif %}{%- endif %}"),
        },
        { source: "b", text: wrapped("'b' in modules", "tail\n") },
      ]),
    ).toEqual([]);
  });

  test("the last contribution may end mid-line on a plain anchor", () => {
    expect(
      renderedSeparationErrors("demo", [
        { source: "a", text: wrapped("'a' in modules", "      - a-job\n") },
        { source: "b", text: wrapped("'b' in modules", "      - b-job") },
      ]),
    ).toEqual([]);
  });

  test("a tight anchor also requires the LAST contribution to end with a newline", () => {
    const errors = renderedSeparationErrors(
      "demo",
      [
        { source: "a", text: wrapped("'a' in modules", "      - a-job\n") },
        { source: "b", text: wrapped("'b' in modules", "      - b-job") },
      ],
      true,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("the anchor is tight");
    expect(errors[0]).toContain("end the fragment body with a newline");
  });

  test("a tight anchor passes when every contribution ends with a newline", () => {
    expect(
      renderedSeparationErrors(
        "demo",
        [
          { source: "a", text: wrapped("'a' in modules", "      - a-job\n") },
          { source: "b", text: wrapped("'b' in modules", "      - b-job\n") },
        ],
        true,
      ),
    ).toEqual([]);
  });
});

describe("lockfileGroups", () => {
  test("consecutive patterns with the same module set share one group", () => {
    expect(lockfileGroups([BUN, UV])).toEqual([
      { patterns: ["bun\\.lock", "bun\\.lockb"], modules: ["bun"] },
      { patterns: ["uv\\.lock"], modules: ["uv"] },
    ]);
  });

  test("a pattern declared by two modules is emitted once with both contributors", () => {
    const sharedNode = manifest("node", ["lockfiles: ['bun\\.lock']"]);
    expect(lockfileGroups([BUN, sharedNode])).toEqual([
      { patterns: ["bun\\.lock"], modules: ["bun", "node"] },
      { patterns: ["bun\\.lockb"], modules: ["bun"] },
    ]);
  });
});
