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
  applyToolchainSetup,
  type Contribution,
  codeqlGroups,
  codeqlSlug,
  dependabotLabels,
  ecosystemGroups,
  fragmentJobIds,
  gateJobsGroups,
  gateJobsParityErrors,
  injectUsesRefPreamble,
  labelBlock,
  lockfileGroups,
  manifestEntries,
  manifestTemplate,
  orChain,
  renderedSeparationErrors,
  type SourcedEntry,
  spliceContributions,
  trackingLabelBlock,
  USES_REF_PREAMBLE,
  yamlLabelName,
} from "../../scripts/compose_template";
import { type ModuleManifest, parseManifest } from "../../scripts/module_manifests";
import { skipIfExistsMatchers } from "../../scripts/ownership";

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

describe("trackingLabelBlock", () => {
  const tracking = {
    answer: "fuzzer_label",
    default: "fuzz-nightly",
    color: "B60205",
    description: "Automated nightly fuzz failure",
  };

  test("the rendered block round-trips through a YAML parser with the answer substituted", () => {
    const block = trackingLabelBlock("fuzzer", tracking).replace(
      "{{ fuzzer_label | tojson }}",
      '"fuzz-nightly"',
    );
    const doc = parseYaml(`labels:\n${block}`) as { labels: Record<string, unknown>[] };
    expect(doc.labels[0]).toEqual({
      name: "fuzz-nightly",
      color: "B60205",
      description: "Automated nightly fuzz failure",
    });
  });

  test("the label name renders from the stream's copier answer, tojson-quoted", () => {
    expect(trackingLabelBlock("fuzzer", tracking)).toContain(
      "  - name: {{ fuzzer_label | tojson }}\n",
    );
  });
});

describe("gateJobsGroups", () => {
  test("each declaring module keeps its own group, in manifest order", () => {
    const rp = manifest("release-please", ["gate_jobs: [release-freshness, release-health]"]);
    const prTitle = manifest("pr-title", ["gate_jobs: [pr-title]"]);
    expect(gateJobsGroups([AGENTS, rp, prTitle])).toEqual([
      { module: "release-please", jobs: ["release-freshness", "release-health"] },
      { module: "pr-title", jobs: ["pr-title"] },
    ]);
  });

  test("a job id declared by two modules throws (duplicate needs entry)", () => {
    expect(() =>
      gateJobsGroups([
        manifest("skills", ["gate_jobs: [validate-skills]"]),
        manifest("pr-title", ["gate_jobs: [validate-skills]"]),
      ]),
    ).toThrow("templates/skills/module.yml");
  });
});

describe("fragmentJobIds", () => {
  test("collects the 2-space mapping keys, skipping comments, steps, and jinja", () => {
    const body = Buffer.from(
      [
        "  # a job comment",
        "  release-freshness:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v7",
        "{%- if x %}",
        "  release-health:",
        "    runs-on: ubuntu-latest",
        "{%- endif %}",
        "",
      ].join("\n"),
    );
    expect(fragmentJobIds(body)).toEqual(["release-freshness", "release-health"]);
  });

  test("job ids beyond gate_jobs' declarable shape still surface (they must fail parity, not escape)", () => {
    const body = Buffer.from(
      "  Security_Scan: # inline note\n    runs-on: ubuntu-latest\n  _lint:\n    runs-on: ubuntu-latest\n",
    );
    expect(fragmentJobIds(body)).toEqual(["Security_Scan", "_lint"]);
  });

  test("quoted job keys still surface (they must fail parity, not escape)", () => {
    const body = Buffer.from(
      "  \"build\":\n    runs-on: ubuntu-latest\n  'deploy':\n    runs-on: ubuntu-latest\n",
    );
    expect(fragmentJobIds(body)).toEqual(["build", "deploy"]);
  });

  test("a space before the key's colon still surfaces (valid YAML the old scanner missed)", () => {
    const body = Buffer.from("  new-job :\n    runs-on: ubuntu-latest\n");
    expect(fragmentJobIds(body)).toEqual(["new-job"]);
  });

  test("a fragment that is not the jobs mapping's children throws instead of scanning past", () => {
    expect(() => fragmentJobIds(Buffer.from("      - not a mapping\n"))).toThrow("jobs mapping");
    expect(() => fragmentJobIds(Buffer.from("  just a scalar line\n"))).toThrow("jobs mapping");
  });

  test("a jinja-derived job key throws (it enumerates as one spelling and renders as another)", () => {
    const body = Buffer.from(
      "  {{ 'safe' if private else 'evil' }}:\n    runs-on: ubuntu-latest\n",
    );
    expect(() => fragmentJobIds(body)).toThrow("literally");
  });

  test("a commented-out key line cannot vouch for a jinja-derived key", () => {
    const body = Buffer.from(
      "{#-\n  safe:\n-#}\n  {{ 'safe' if private else 'evil' }}:\n    runs-on: ubuntu-latest\n",
    );
    expect(() => fragmentJobIds(body)).toThrow("literally");
  });
});

describe("gateJobsParityErrors", () => {
  const fragment = Buffer.from("  pr-title:\n    runs-on: ubuntu-latest\n");

  test("matching declarations and fragment jobs pass", () => {
    expect(gateJobsParityErrors("pr-title", ["pr-title"], fragment)).toEqual([]);
    expect(gateJobsParityErrors("agents", undefined, undefined)).toEqual([]);
  });

  test("an unparseable fragment fails closed, naming the fragment", () => {
    const errors = gateJobsParityErrors("pr-title", ["pr-title"], Buffer.from("      - item\n"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("templates/pr-title/fragments/ci-gate-jobs.jinja");
    expect(errors[0]).toContain("fails closed");
  });

  test("a fragment job the manifest does not declare fails (it would escape the gate)", () => {
    const errors = gateJobsParityErrors("pr-title", undefined, fragment);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("outside the strict all-green gate");
  });

  test("a declared job the fragment does not define fails (a needs entry nothing satisfies)", () => {
    const errors = gateJobsParityErrors("pr-title", ["pr-title", "ghost"], fragment);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("'ghost'");
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

describe("injectUsesRefPreamble", () => {
  const preamble = USES_REF_PREAMBLE.join("\n");

  test("a file without a uses_ref reference is left alone", () => {
    expect(injectUsesRefPreamble("templates/base/x.jinja", Buffer.from("name: X\n"))).toBeNull();
  });

  test("the preamble lands after the leading run of # comment lines", () => {
    const result = injectUsesRefPreamble(
      "templates/nightly/w.yml.jinja",
      Buffer.from("# managed header\n# second line\nname: X\nuses: o/r/a@{{ uses_ref }}\n"),
    );
    if (result === null || "error" in result) throw new Error("expected an injection");
    expect(result.data.toString("utf-8")).toBe(
      `# managed header\n# second line\n${preamble}\nname: X\nuses: o/r/a@{{ uses_ref }}\n`,
    );
  });

  test("a file with no leading comments gets the preamble at the very top", () => {
    const result = injectUsesRefPreamble(
      "templates/base/ci.yml.jinja",
      Buffer.from("{#- header -#}\nuses: o/r/a@{{ uses_ref }}\n"),
    );
    if (result === null || "error" in result) throw new Error("expected an injection");
    expect(result.data.toString("utf-8")).toBe(
      `${preamble}\n{#- header -#}\nuses: o/r/a@{{ uses_ref }}\n`,
    );
  });

  test("a blank line ends the header run: the preamble sits before it", () => {
    const result = injectUsesRefPreamble(
      "templates/pages/w.yml.jinja",
      Buffer.from("# header\n\nname: X\nuses: o/r/a@{{ uses_ref }}\n"),
    );
    if (result === null || "error" in result) throw new Error("expected an injection");
    expect(result.data.toString("utf-8")).toBe(
      `# header\n${preamble}\n\nname: X\nuses: o/r/a@{{ uses_ref }}\n`,
    );
  });

  test("a hand-written derivation line errors instead of double-defining", () => {
    for (const hand of [
      "{%- set tpl_ref = _copier_answers._commit -%}",
      "{%- set release_pin = tpl_ref -%}",
      "{%- set uses_ref = 'main' %}",
      "{% set  uses_ref = 'main' %}",
      "{%+ set uses_ref = 'main' %}",
      "{% set (uses_ref) = 'main' %}",
      "{% set extra, uses_ref = 1, 'main' %}",
      "{% set tpl_ref %}templates/v1.2.3{% endset %}",
    ]) {
      const result = injectUsesRefPreamble(
        "templates/demo/w.yml.jinja",
        Buffer.from(`# h\n${hand}\nuses: o/r/a@{{ uses_ref }}\n`),
      );
      if (result === null || !("error" in result)) throw new Error("expected an error");
      expect(result.error).toContain("templates/demo/w.yml.jinja");
      expect(result.error).toContain("hand-writes");
    }
  });

  test("reading a derivation name on a set's VALUE side stays legitimate", () => {
    const result = injectUsesRefPreamble(
      "templates/demo/w.yml.jinja",
      Buffer.from("# h\n{%- set banner = uses_ref -%}\nuses: o/r/a@{{ uses_ref }}\n"),
    );
    if (result === null || "error" in result) throw new Error("expected an injection");
    expect(result.data.toString("utf-8")).toContain("{%- set banner = uses_ref -%}");
    expect(result.data.toString("utf-8")).toContain(USES_REF_PREAMBLE[6]);
  });

  test("a set-assignment smuggled inside a string value still errors (fail closed, not quote-aware)", () => {
    const result = injectUsesRefPreamble(
      "templates/demo/w.yml.jinja",
      Buffer.from(
        '# h\n{% set banner = "%} {% set uses_ref = x %}" %}\nuses: o/r/a@{{ uses_ref }}\n',
      ),
    );
    if (result === null || !("error" in result)) throw new Error("expected the fail-closed error");
    expect(result.error).toContain("hand-writes");
  });

  test("the canonical preamble itself carries every derivation line and no hand-copy bait", () => {
    // The injector must never re-inject into its own output.
    const once = injectUsesRefPreamble("t", Buffer.from("uses: o/r/a@{{ uses_ref }}\n"));
    if (once === null || "error" in once) throw new Error("expected an injection");
    const twice = injectUsesRefPreamble("t", once.data);
    if (twice === null || !("error" in twice)) throw new Error("expected the tripwire");
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

describe("spliceContributions", () => {
  const skeleton = (text: string): Map<string, SourcedEntry> =>
    new Map([["demo.yml", { origin: "base", entry: { kind: "file", data: Buffer.from(text) } }]]);
  const contribution = (body: string): Map<string, Contribution[]> =>
    new Map([
      ["demo", [{ order: 0, source: "templates/a/fragments/demo.jinja", text: Buffer.from(body) }]],
    ]);
  const dataOf = (files: Map<string, SourcedEntry>): string => {
    const entry = (files.get("demo.yml") as SourcedEntry).entry;
    if (entry.kind !== "file") throw new Error("expected a file entry");
    return entry.data.toString("utf-8");
  };

  test("a plain anchor keeps the marker line's newline", () => {
    const files = skeleton("needs:\n{# compose:demo #}\n    runs-on: x\n");
    const errors = spliceContributions(files, contribution("{% if g %}      - a\n{% endif %}"));
    expect(errors).toEqual([]);
    expect(dataOf(files)).toBe("needs:\n{% if g %}      - a\n{% endif %}\n    runs-on: x\n");
  });

  test("a tight anchor absorbs the marker line's newline into the next line", () => {
    const files = skeleton("needs:\n{# compose:demo -#}\n    runs-on: x\n");
    const errors = spliceContributions(files, contribution("{% if g %}      - a\n{% endif %}"));
    expect(errors).toEqual([]);
    expect(dataOf(files)).toBe("needs:\n{% if g %}      - a\n{% endif %}    runs-on: x\n");
  });

  test("a tight anchor at end of file becomes the last line", () => {
    const files = skeleton("needs:\n{# compose:demo -#}\n");
    const errors = spliceContributions(files, contribution("{% if g %}      - a\n{% endif %}"));
    expect(errors).toEqual([]);
    expect(dataOf(files)).toBe("needs:\n{% if g %}      - a\n{% endif %}");
  });

  test("a tight anchor rejects a contribution ending mid-line", () => {
    const files = skeleton("needs:\n{# compose:demo -#}\n    runs-on: x\n");
    const errors = spliceContributions(files, contribution("{% if g %}      - a{% endif %}"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("the anchor is tight");
  });

  test("a tight anchor rejects a trailing literal", () => {
    const files = skeleton("{# compose:demo -#}tail\n");
    const errors = spliceContributions(files, contribution("{% if g %}      - a\n{% endif %}"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("is tight (-#}) but carries a trailing literal");
  });

  test("an anchor with no contributions is an error, never a silent no-op splice", () => {
    const files = skeleton("needs:\n{# compose:demo #}\n    runs-on: x\n");
    const errors = spliceContributions(files, new Map());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("anchor 'demo' has no contributions");
    expect(dataOf(files)).toContain("{# compose:demo #}");
  });

  test("contributions splice in MODULE_ORDER order regardless of input order", () => {
    const files = skeleton("needs:\n{# compose:demo -#}\n    runs-on: x\n");
    const contributions = new Map<string, Contribution[]>([
      [
        "demo",
        [
          { order: 2, source: "b", text: Buffer.from("{% if b %}      - b\n{% endif %}") },
          { order: 1, source: "a", text: Buffer.from("{% if a %}      - a\n{% endif %}") },
        ],
      ],
    ]);
    expect(spliceContributions(files, contributions)).toEqual([]);
    expect(dataOf(files)).toBe(
      "needs:\n{% if a %}      - a\n{% endif %}{% if b %}      - b\n{% endif %}    runs-on: x\n",
    );
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

describe("manifestEntries", () => {
  const skip = skipIfExistsMatchers(
    ["_skip_if_exists:", "  - .github/workflows/checks.yml"].join("\n"),
  );
  const file = (text: string) => ({ kind: "file", data: Buffer.from(text) }) as const;
  const base = (text: string): SourcedEntry => ({ origin: "base", entry: file(text) });
  const mod = (module: string, text: string): SourcedEntry => ({
    origin: "module",
    module,
    gate: `'${module}' in modules`,
    gateDirs: [],
    entry: file(text),
  });

  test("classifies base and module files with their render gates, sorted, self-listed", () => {
    const files = new Map<string, SourcedEntry>([
      [".github/workflows/ci.yml.jinja", base("# managed\n")],
      [".github/workflows/checks.yml.jinja", base("# starter\n")],
      [
        "{% if not private %}CONTRIBUTING.md{% endif %}.jinja",
        base("<!-- repo-platform:local-section -->\n"),
      ],
      [
        ".github/workflows/release.yml.jinja",
        mod("release-please", "# This file is managed by {{ github_username }}/repo-platform.\n"),
      ],
      [
        "CLAUDE.md",
        {
          origin: "module",
          module: "agents",
          gate: "'agents' in modules",
          gateDirs: [],
          entry: { kind: "symlink", target: "AGENTS.md" },
        },
      ],
    ]);
    const { entries, errors } = manifestEntries(files, skip);
    expect(errors).toEqual([]);
    expect(entries).toEqual([
      { path: ".github/repo-platform-manifest.json", gates: [], ownership: { class: "managed" } },
      { path: ".github/workflows/checks.yml", gates: [], ownership: { class: "starter" } },
      { path: ".github/workflows/ci.yml", gates: [], ownership: { class: "managed" } },
      {
        path: ".github/workflows/release.yml",
        gates: ["'release-please' in modules"],
        ownership: { class: "managed" },
      },
      { path: "CLAUDE.md", gates: ["'agents' in modules"], ownership: { class: "managed" } },
      {
        path: "CONTRIBUTING.md",
        gates: ["not private"],
        ownership: {
          class: "split",
          marker: "<!-- repo-platform:local-section -->",
          managed: "above",
        },
      },
    ]);
  });

  test("a mergeable-marked source classifies mergeable in the manifest", () => {
    const files = new Map<string, SourcedEntry>([
      [
        ".github/settings.yml.jinja",
        mod("settings-sync", "---\n# repo-platform:mergeable\nrepository: {}\n"),
      ],
    ]);
    const { entries, errors } = manifestEntries(files, skip);
    expect(errors).toEqual([]);
    expect(entries.find((e) => e.path === ".github/settings.yml")?.ownership).toEqual({
      class: "mergeable",
    });
  });

  test("two sources landing at one path is an error, not a duplicate key", () => {
    const files = new Map<string, SourcedEntry>([
      ["{% if not private %}X.md{% endif %}.jinja", base("a\n")],
      ["X.md.jinja", mod("agents", "b\n")],
    ]);
    const { errors } = manifestEntries(files, skip);
    expect(errors.join("\n")).toContain("both land at X.md");
  });

  test("a template landing at the manifest's own path collides with the self entry", () => {
    const files = new Map<string, SourcedEntry>([
      [".github/repo-platform-manifest.json.jinja", base("{}\n")],
    ]);
    const { errors } = manifestEntries(files, skip);
    expect(errors.join("\n")).toContain("both land at .github/repo-platform-manifest.json");
  });
});

describe("manifestTemplate", () => {
  test("emits gated appends and a joined JSON skeleton with null hashes", () => {
    const text = manifestTemplate([
      { path: ".github/workflows/ci.yml", gates: [], ownership: { class: "managed" } },
      { path: ".github/repo-platform-manifest.json", gates: [], ownership: { class: "managed" } },
      {
        path: "AGENTS.md",
        gates: ["'agents' in modules"],
        ownership: {
          class: "split",
          marker: "<!-- repo-platform:local-section -->",
          managed: "above",
        },
      },
      {
        path: "checks.yml",
        gates: ["'a' in modules", "not private"],
        ownership: { class: "starter" },
      },
      {
        path: ".github/settings.yml",
        gates: ["'settings-sync' in modules"],
        ownership: { class: "mergeable" },
      },
    ]).toString("utf-8");
    expect(text).toContain(
      `{%- set _ = entries.append('    ".github/workflows/ci.yml": {"class": "managed", "hash": null}') -%}`,
    );
    // The self entry alone carries the provenance slot the stamper fills.
    expect(text).toContain(
      `'    ".github/repo-platform-manifest.json": {"class": "managed", "hash": null, "commit": null}'`,
    );
    expect(text).toContain("{%- if 'agents' in modules -%}");
    expect(text).toContain('"managed": "above", "hash": null');
    expect(text).toContain("{%- if ('a' in modules) and (not private) -%}");
    // No-parity classes carry no hash token for the stamper to fill.
    expect(text).toContain(`'    "checks.yml": {"class": "starter"}'`);
    expect(text).toContain(`'    ".github/settings.yml": {"class": "mergeable"}'`);
    expect(text).toContain("{{ entries | join(',\\n') }}");
    expect(text.endsWith("}\n")).toBe(true);
  });
});
