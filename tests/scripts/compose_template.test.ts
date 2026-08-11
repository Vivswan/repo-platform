// Unit tests for the composer's data-anchor derivations: value grouping,
// the CodeQL slug rule (including the duplicate-job-key collision guard),
// or-chain gate rendering, and YAML label quoting with a round-trip parse
// oracle - covering the future shapes (two modules sharing a CodeQL
// language, a dependabot label, or a lockfile pattern) that the sharing
// rule must emit once behind an or-chain gate.

import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import {
  agentsToolchainErrors,
  codeqlGroups,
  codeqlSlug,
  dependabotLabels,
  ecosystemGroups,
  labelBlock,
  lockfileGroups,
  orChain,
  renderedSeparationErrors,
  yamlLabelName,
} from "../../scripts/compose_template";
import { type ModuleManifest, parseManifest } from "../../scripts/module_manifests";

function manifest(module: string, body: string[]): ModuleManifest {
  return parseManifest(
    module,
    ["description: a test module", ...body].join("\n"),
    `templates/${module}/module.yml`,
  );
}

const BUN = manifest("bun", [
  "toolchain: {codeql_language: javascript-typescript}",
  'dependabot: {ecosystem: bun, label: javascript, color: "168700"}',
  "lockfiles: ['bun\\.lock', 'bun\\.lockb']",
]);
const NODE = manifest("node", [
  "toolchain: {codeql_language: javascript-typescript}",
  'dependabot: {ecosystem: npm, label: javascript, color: "168700"}',
  "lockfiles: ['package-lock\\.json']",
]);
const UV = manifest("uv", [
  "toolchain: {codeql_language: python}",
  'dependabot: {ecosystem: uv, label: "python:uv", color: "2b67c6"}',
  "lockfiles: ['uv\\.lock']",
]);
const AGENTS = manifest("agents", []);

function gateOfFor(manifests: ModuleManifest[]): (module: string) => string {
  const gates = new Map(manifests.map((m) => [m.module, m.gate ?? `'${m.module}' in modules`]));
  return (module) => {
    const gate = gates.get(module);
    if (gate === undefined) throw new Error(`no gate for '${module}'`);
    return gate;
  };
}

describe("codeqlSlug", () => {
  test("takes the first dash-separated word", () => {
    expect(codeqlSlug("javascript-typescript")).toBe("javascript");
    expect(codeqlSlug("python")).toBe("python");
  });
});

describe("orChain", () => {
  const gateOf = gateOfFor([BUN, NODE]);

  test("a single module renders its own gate", () => {
    expect(orChain(["bun"], gateOf)).toBe("'bun' in modules");
  });

  test("several modules chain their gates with 'or' in the given order", () => {
    expect(orChain(["bun", "node"], gateOf)).toBe("'bun' in modules or 'node' in modules");
  });

  test("a custom manifest gate participates verbatim", () => {
    const custom = gateOfFor([manifest("demo", ["gate: not private"]), manifest("other", [])]);
    expect(orChain(["demo", "other"], custom)).toBe("not private or 'other' in modules");
  });

  test("an unknown module fails loudly instead of guessing a gate", () => {
    expect(() => orChain(["ghost"], gateOf)).toThrow("ghost");
  });
});

describe("yamlLabelName", () => {
  test("plainly safe labels stay unquoted", () => {
    expect(yamlLabelName("javascript")).toBe("javascript");
    expect(yamlLabelName("rust")).toBe("rust");
    expect(yamlLabelName("deno")).toBe("deno");
  });

  test("anything else gets quotes: colons, leading digits, YAML reserved words", () => {
    expect(yamlLabelName("python:uv")).toBe('"python:uv"');
    expect(yamlLabelName("123")).toBe('"123"');
    expect(yamlLabelName("true")).toBe('"true"');
    expect(yamlLabelName("null")).toBe('"null"');
  });
});

describe("labelBlock", () => {
  test("the rendered block round-trips through a YAML parser as strings", () => {
    for (const name of ["javascript", "python:uv", "true", "123"]) {
      const block = labelBlock({
        name,
        color: "2b67c6",
        description: `Pull requests that update ${name} code`,
        modules: ["demo"],
      });
      const doc = parseYaml(`labels:\n${block}`) as { labels: Record<string, unknown>[] };
      expect(doc.labels[0]).toEqual({
        name,
        color: "2b67c6",
        description: `Pull requests that update ${name} code`,
      });
    }
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
      { language: "javascript-typescript", slug: "javascript", modules: ["bun", "node"] },
      { language: "python", slug: "python", modules: ["uv"] },
    ]);
  });

  test("two distinct languages deriving one slug throw (duplicate YAML job keys)", () => {
    const bare = manifest("bare-js", ["toolchain: {codeql_language: javascript}"]);
    expect(() => codeqlGroups([BUN, bare])).toThrow("codeql-javascript");
    expect(() => codeqlGroups([BUN, bare])).toThrow("javascript-typescript");
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

  test("a dependabot-only module without the fragment errors", () => {
    const errors = agentsToolchainErrors([dependabotOnly], new Set());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("templates/cargo/module.yml declares dependabot but");
    expect(errors[0]).toContain("fragments/agents-toolchain.jinja");
  });

  test("a toolchain-only module without the fragment errors too (codeql-only shape)", () => {
    const errors = agentsToolchainErrors([codeqlOnly], new Set());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("templates/zig/module.yml declares a toolchain but");
  });

  test("a module declaring both names both in its error", () => {
    const errors = agentsToolchainErrors([BUN], new Set());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("declares dependabot and a toolchain but");
  });
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

  test("the last contribution may end mid-line (pr-title's gate entry)", () => {
    expect(
      renderedSeparationErrors("demo", [
        { source: "a", text: wrapped("'a' in modules", "      - a-job\n") },
        { source: "b", text: wrapped("'b' in modules", "      - b-job") },
      ]),
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
