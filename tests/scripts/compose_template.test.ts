// Unit tests for the composer's data-anchor derivations: value grouping,
// the CodeQL slug rule (including the duplicate-job-key collision guard),
// and or-chain gate rendering - covering the future shapes (two modules
// sharing a CodeQL language, a dependabot label, or a lockfile pattern)
// that the sharing rule must emit once behind an or-chain gate.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentsToolchainErrors,
  applyToolchainSetup,
  type Contribution,
  codeqlGroups,
  codeqlSlug,
  type DeclarationSources,
  dependabotLabels,
  ecosystemGroups,
  excludePatterns,
  fragmentJobIds,
  fragmentMarkerErrors,
  gateJobsGroups,
  gateJobsParityErrors,
  gitwildmatchLiteral,
  lockfileGroups,
  manifestEntries,
  manifestTemplate,
  orChain,
  plainTemplatePath,
  renderedSeparationErrors,
  type SourcedEntry,
  spliceContributions,
  templatePathErrors,
} from "../../scripts/compose_template";
import { renderJinjaFile } from "../../scripts/jinja_subset";
import { type ModuleManifest, parseManifest } from "../../scripts/module_manifests";
import { type OwnershipDeclaration, skipIfExistsPatterns } from "../../scripts/ownership";

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
  test("collects the 2-space mapping keys, skipping comments, steps, and value-side jinja", () => {
    const body = Buffer.from(
      [
        "  # a job comment",
        "  release-freshness:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v7",
        "  release-health:",
        "    runs-on: ubuntu-latest",
        "{%- if x %}",
        "    timeout-minutes: 5",
        "{%- endif %}",
        "",
      ].join("\n"),
    );
    expect(fragmentJobIds(body)).toEqual(["release-freshness", "release-health"]);
  });

  test("the live release-please fragment (value-side jinja only) still enumerates", () => {
    const body = readFileSync(
      join(import.meta.dir, "../../templates/release-please/fragments/ci-gate-jobs.jinja"),
    );
    expect(fragmentJobIds(body)).toEqual(["release-freshness", "release-health"]);
  });

  test("a job key inside a jinja {% if %} block throws (it would enumerate as unconditional)", () => {
    const body = Buffer.from(
      ["{%- if x %}", "  cond-job:", "    runs-on: ubuntu-latest", "{%- endif %}", ""].join("\n"),
    );
    expect(() => fragmentJobIds(body)).toThrow("gate jobs render unconditionally");
  });

  test("depth tracking: a key after nested statements close passes, one between them throws", () => {
    const closed = Buffer.from(
      [
        "  ok-job:",
        "    runs-on: ubuntu-latest",
        "{% if a %}{% if b %}",
        "    x: 1",
        "{% endif %}{% endif %}",
        "  after-job:",
        "    runs-on: ubuntu-latest",
        "",
      ].join("\n"),
    );
    expect(fragmentJobIds(closed)).toEqual(["ok-job", "after-job"]);
    const open = Buffer.from(
      [
        "  outer-job:",
        "    runs-on: ubuntu-latest",
        "{% if a %}{% if b %}",
        "    x: 1",
        "{% endif %}",
        "  nested-job:",
        "    runs-on: ubuntu-latest",
        "{% endif %}",
        "",
      ].join("\n"),
    );
    expect(() => fragmentJobIds(open)).toThrow("gate jobs render unconditionally");
  });

  test("unbalanced statement tags throw - underflow could hide a conditioned key at depth zero", () => {
    const underflow = Buffer.from(
      ["{% endif %}", "  cond-job:", "    runs-on: ubuntu-latest", "{% if x %}", ""].join("\n"),
    );
    expect(() => fragmentJobIds(underflow)).toThrow("closes a jinja {% if %} it never opened");
    const unclosed = Buffer.from(
      ["  a-job:", "    runs-on: ubuntu-latest", "{% if x %}", "    y: 1", ""].join("\n"),
    );
    expect(() => fragmentJobIds(unclosed)).toThrow("leaves a jinja {% if %} unclosed");
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

describe("fragmentMarkerErrors", () => {
  const frag = (
    anchor: string,
    module: string,
    body: string,
  ): [string, [ModuleManifest, Buffer][]] => [anchor, [[manifest(module, []), Buffer.from(body)]]];

  test("a smuggled marker in toolchain-setup.jinja names toolchain-setup.jinja, not its targets", () => {
    // applyToolchainSetup would copy the bytes into the auto-format and
    // copilot-setup-steps contributions, whose sources name those targets;
    // the raw-map scan runs first and names the file that carries the line.
    const fragments = new Map([
      frag("toolchain-setup", "uv", "{# compose:evil #}\nsteps\n"),
      frag("auto-format", "uv", "fmt\n"),
      frag("copilot-setup-steps", "uv", "setup\n"),
    ]);
    const errors = fragmentMarkerErrors(fragments);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("templates/uv/fragments/toolchain-setup.jinja");
  });

  test("a smuggled marker in a generator-consumed fragment names that fragment", () => {
    // The agents-toolchain consume generator folds its input fragments into
    // one contribution sourced to the built-in generator; the raw-map scan
    // still names the fragment.
    const fragments = new Map([frag("agents-toolchain", "bun", "- bullet {#- compose:evil #}\n")]);
    const errors = fragmentMarkerErrors(fragments);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("templates/bun/fragments/agents-toolchain.jinja");
    expect(errors[0]).toContain("'{#- compose:'");
  });

  test("marker-free fragments pass", () => {
    const fragments = new Map([frag("ci-gate-jobs", "uv", "  job:\n    runs-on: x\n")]);
    expect(fragmentMarkerErrors(fragments)).toEqual([]);
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
  const contribution = (body: string, gate: string | null = null): Map<string, Contribution[]> =>
    new Map([
      [
        "demo",
        [{ order: 0, source: "templates/a/fragments/demo.jinja", gate, text: Buffer.from(body) }],
      ],
    ]);
  const dataOf = (files: Map<string, SourcedEntry>): string => {
    const entry = (files.get("demo.yml") as SourcedEntry).entry;
    if (entry.kind !== "file") throw new Error("expected a file entry");
    return entry.data.toString("utf-8");
  };

  test("a plain anchor keeps the marker line's newline for a gateless contribution", () => {
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
          {
            order: 2,
            source: "b",
            gate: "b",
            text: Buffer.from("{% if b %}      - b\n{% endif %}"),
          },
          {
            order: 1,
            source: "a",
            gate: "a",
            text: Buffer.from("{% if a %}      - a\n{% endif %}"),
          },
        ],
      ],
    ]);
    expect(spliceContributions(files, contributions)).toEqual([]);
    expect(dataOf(files)).toBe(
      "needs:\n{% if a %}      - a\n{% endif %}{% if b %}      - b\n{% endif %}    runs-on: x\n",
    );
  });

  test("a contribution smuggling a well-formed anchor marker errors, naming the fragment", () => {
    const files = skeleton("needs:\n{# compose:demo #}\n    runs-on: x\n");
    const errors = spliceContributions(
      files,
      contribution("{% if g %}{# compose:other #}\n      - a\n{% endif %}", "g"),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("templates/a/fragments/demo.jinja");
    expect(errors[0]).toContain("anchor marker");
    // Fail closed: nothing spliced, the skeleton keeps its own marker.
    expect(dataOf(files)).toContain("{# compose:demo #}");
  });

  test("a contribution smuggling a malformed anchor marker errors too", () => {
    const files = skeleton("needs:\n{# compose:demo #}\n    runs-on: x\n");
    const errors = spliceContributions(
      files,
      contribution("{% if g %}  {# compose:bad\n      - a\n{% endif %}", "g"),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("anchor marker");
  });

  test("smuggled markers with variant comment-opener spellings error too", () => {
    for (const bad of ["{#- compose:other #}", "{#  compose:other #}", "{#compose:other #}"]) {
      const files = skeleton("needs:\n{# compose:demo #}\n    runs-on: x\n");
      const errors = spliceContributions(
        files,
        contribution(`{% if g %}${bad}\n      - a\n{% endif %}`, "g"),
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("templates/a/fragments/demo.jinja");
      expect(errors[0]).toContain("anchor marker");
      // The error quotes the offending spelling, opener through the colon.
      expect(errors[0]).toContain(`'${bad.slice(0, bad.indexOf(":") + 1)}'`);
    }
  });

  test("the recognizer is same-line: a newline inside the opener matches neither scan", () => {
    // Not marker-shaped on either side (markers are line constructs); the
    // split spelling stays a plain jinja comment in skeletons and
    // contributions alike, keeping the two scans agreeing on the same bytes.
    const split = "{#\n compose:ghost #}";
    const files = skeleton(`${split}\nneeds:\n{# compose:demo #}\n    runs-on: x\n`);
    const errors = spliceContributions(
      files,
      contribution(`{% if g %}${split}\n      - a\n{% endif %}`, "g"),
    );
    expect(errors).toEqual([]);
  });

  test("a skeleton compose marker with a variant spelling errors as malformed", () => {
    for (const bad of ["{#- compose:demo2 #}", "{#  compose:demo2 #}", "{#compose:demo2 #}"]) {
      const files = skeleton(`needs:\n{# compose:demo #}\n${bad}\n`);
      const errors = spliceContributions(files, contribution("{% if g %}      - a\n{% endif %}"));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("malformed anchor line");
    }
  });

  test("a benign jinja comment mentioning compose in prose is not a marker on either side", () => {
    const files = skeleton("{# composes the tree #}\nneeds:\n{# compose:demo #}\n    runs-on: x\n");
    const errors = spliceContributions(
      files,
      contribution("{% if g %}{# composes the tree #}\n      - a\n{% endif %}", "g"),
    );
    expect(errors).toEqual([]);
  });
});

// The collapse guard is a render-time fix (an all-false anchor line must
// leave no blank line), so these tests assert RENDERED output through the
// same jinja-subset renderer the dogfood pipeline trusts, not just the
// composed bytes.
describe("collapse guard", () => {
  const vars = { username: "U", slug: "s", copyrightHolder: "C" };
  const wrap = (gate: string, body: string) => ({
    gate,
    text: `{% if ${gate} %}${body}{% endif %}`,
  });
  const splice = (
    skeletonText: string,
    contributions: { gate: string | null; text: string }[],
  ): string => {
    const files: Map<string, SourcedEntry> = new Map([
      ["demo.yml", { origin: "base", entry: { kind: "file", data: Buffer.from(skeletonText) } }],
    ]);
    const list = contributions.map(({ gate, text }, order) => ({
      order,
      source: `templates/m${order}/fragments/demo.jinja`,
      gate,
      text: Buffer.from(text),
    }));
    const errors = spliceContributions(files, new Map([["demo", list]]));
    expect(errors).toEqual([]);
    const entry = (files.get("demo.yml") as SourcedEntry).entry;
    if (entry.kind !== "file") throw new Error("expected a file entry");
    return entry.data.toString("utf-8");
  };

  test("an anchor whose only contribution renders false leaves no blank line", () => {
    // The .typography-allow shape: the anchor is the last line, the file
    // ends with a newline.
    const composed = splice("# header\n{# compose:demo #}\n", [wrap("g", "CHANGELOG.md")]);
    expect(composed).toBe("# header\n{% if g %}CHANGELOG.md{% endif %}{% if g %}\n{% endif %}");
    expect(renderJinjaFile(composed, vars, { g: false })).toBe("# header\n");
    expect(renderJinjaFile(composed, vars, { g: true })).toBe("# header\nCHANGELOG.md\n");
  });

  test("two contributions: selected states match the unguarded splice, all-false collapses", () => {
    const composed = splice("needs:\n{# compose:demo #}\n    runs-on: x\n", [
      wrap("g1", "      - a\n"),
      wrap("g2", "      - b"),
    ]);
    const unguarded =
      "needs:\n{% if g1 %}      - a\n{% endif %}{% if g2 %}      - b{% endif %}\n    runs-on: x\n";
    for (const [g1, g2] of [
      [true, true],
      [true, false],
      [false, true],
    ] as const) {
      // The guard condition is its own template expression; the renderer
      // resolves conditions by exact context key, so it gets its own entry.
      const context = { g1, g2, "(g1) or (g2)": g1 || g2 };
      expect(renderJinjaFile(composed, vars, context)).toBe(
        renderJinjaFile(unguarded, vars, { g1, g2 }),
      );
    }
    const allFalse = { g1: false, g2: false, "(g1) or (g2)": false };
    expect(renderJinjaFile(composed, vars, allFalse)).toBe("needs:\n    runs-on: x\n");
    expect(renderJinjaFile(unguarded, vars, { g1: false, g2: false })).toBe(
      "needs:\n\n    runs-on: x\n",
    );
  });

  test("contributions sharing one gate emit it once, unparenthesized", () => {
    const composed = splice("h\n{# compose:demo #}\nnext\n", [wrap("g", "a\n"), wrap("g", "b")]);
    expect(composed).toBe(
      "h\n{% if g %}a\n{% endif %}{% if g %}b{% endif %}{% if g %}\n{% endif %}next\n",
    );
  });

  test("no guard when the marker line has no newline to guard", () => {
    // The dependabot.yml shape: the anchor is the file's unterminated
    // last line.
    const composed = splice("h\n{# compose:demo #}", [wrap("g", "body")]);
    expect(composed).toBe("h\n{% if g %}body{% endif %}");
  });

  test("no guard when any contribution manages its own whitespace (gate null)", () => {
    const composed = splice("h\n{# compose:demo #}\nnext\n", [
      { gate: null, text: "{%- if g %}{% set _ = x.append(1) %}{% endif %}" },
    ]);
    expect(composed).toBe("h\n{%- if g %}{% set _ = x.append(1) %}{% endif %}\nnext\n");
  });

  test("no guard behind a trailing literal - collapsing would fuse it onto the next line", () => {
    const composed = splice("h\n{# compose:demo #}tail\nnext\n", [
      wrap("g", "{% if x %}body\n{% endif %}"),
    ]);
    expect(composed).toBe("h\n{% if g %}{% if x %}body\n{% endif %}{% endif %}tail\nnext\n");
  });

  test("no guard when the spliced text ends with a trimming closer", () => {
    // Even with trailing whitespace after it, newlines included: jinja's
    // `-` closer trims the whole run through to the anchor newline, which
    // must therefore stay outside any guard block. (Render-level truth for
    // the skip cases is pinned by the copier smoke renders; jinja_subset's
    // flattened whitespace control is not node-faithful around trims.)
    for (const text of [
      "{% if g %}body\n{% endif -%}",
      "{% if g %}body\n{% endif -%}  ",
      "{% if g %}body\n{% endif -%}\n",
      "{% if g %}body\n{% endif %}{{ v -}}",
      "{% if g %}body\n{% endif %}{# c -#}",
    ]) {
      const composed = splice("h\n{# compose:demo #}\nnext\n", [{ gate: "g", text }]);
      expect(composed).toBe(`h\n${text}\nnext\n`);
    }
  });

  test("no guard when a trimming opener follows across whitespace - it already eats the newline", () => {
    // The codeql-languages shape: the line after the anchor starts {%-.
    // Direct, indented, expression/comment openers, and across a blank
    // line: the trim reaches back through the whole whitespace run.
    for (const following of [
      "{%- if h %}x\n{% endif %}\n",
      "  {%- if h %}x\n{% endif %}\n",
      "\n{%- if h %}x\n{% endif %}\n",
      "{{- v }}\n",
      "{#- c #}\n",
    ]) {
      const composed = splice(`h\n{# compose:demo #}\n${following}`, [wrap("g", "body\n")]);
      expect(composed).toBe(`h\n{% if g %}body\n{% endif %}\n${following}`);
    }
  });

  test("consecutive anchors both collapse independently", () => {
    const files: Map<string, SourcedEntry> = new Map([
      [
        "demo.yml",
        {
          origin: "base",
          entry: { kind: "file", data: Buffer.from("h\n{# compose:a #}\n{# compose:b #}\nnext\n") },
        },
      ],
    ]);
    const contributions = new Map<string, Contribution[]>([
      ["a", [{ order: 0, source: "sa", gate: "ga", text: Buffer.from("{% if ga %}A{% endif %}") }]],
      ["b", [{ order: 0, source: "sb", gate: "gb", text: Buffer.from("{% if gb %}B{% endif %}") }]],
    ]);
    expect(spliceContributions(files, contributions)).toEqual([]);
    const entry = (files.get("demo.yml") as SourcedEntry).entry;
    if (entry.kind !== "file") throw new Error("expected a file entry");
    const composed = entry.data.toString("utf-8");
    expect(composed).toBe(
      "h\n{% if ga %}A{% endif %}{% if ga %}\n{% endif %}" +
        "{% if gb %}B{% endif %}{% if gb %}\n{% endif %}next\n",
    );
    const render = (ga: boolean, gb: boolean) => renderJinjaFile(composed, vars, { ga, gb });
    expect(render(true, true)).toBe("h\nA\nB\nnext\n");
    expect(render(true, false)).toBe("h\nA\nnext\n");
    expect(render(false, true)).toBe("h\nB\nnext\n");
    expect(render(false, false)).toBe("h\nnext\n");
  });

  test("a next anchor whose replacement opens with a trim suppresses the guard", () => {
    const files: Map<string, SourcedEntry> = new Map([
      [
        "demo.yml",
        {
          origin: "base",
          entry: { kind: "file", data: Buffer.from("h\n{# compose:a #}\n{# compose:b #}\nnext\n") },
        },
      ],
    ]);
    const contributions = new Map<string, Contribution[]>([
      [
        "a",
        [{ order: 0, source: "sa", gate: "ga", text: Buffer.from("{% if ga %}A\n{% endif %}") }],
      ],
      [
        "b",
        [
          {
            order: 0,
            source: "sb",
            gate: null,
            text: Buffer.from("{%- if gb %}{% set _ = x.append(1) %}{% endif %}"),
          },
        ],
      ],
    ]);
    expect(spliceContributions(files, contributions)).toEqual([]);
    const entry = (files.get("demo.yml") as SourcedEntry).entry;
    if (entry.kind !== "file") throw new Error("expected a file entry");
    expect(entry.data.toString("utf-8")).toBe(
      "h\n{% if ga %}A\n{% endif %}\n{%- if gb %}{% set _ = x.append(1) %}{% endif %}\nnext\n",
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
  const skip = skipIfExistsPatterns(
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
  const SENTINEL = "<!-- repo-platform:local-section -->";
  const declarations = (over: Partial<DeclarationSources> = {}): DeclarationSources => ({
    base: [
      { path: ".github/workflows/ci.yml", class: "managed" },
      { path: ".github/workflows/checks.yml", class: "starter" },
      { path: "CONTRIBUTING.md", class: "split", grammar: "tail-marker", marker: SENTINEL },
    ],
    modules: new Map([
      ["agents", [{ path: "CLAUDE.md", class: "managed" }] as OwnershipDeclaration[]],
      [
        "release-please",
        [{ path: ".github/workflows/release.yml", class: "managed" }] as OwnershipDeclaration[],
      ],
    ]),
    ...over,
  });
  const FILES = new Map<string, SourcedEntry>([
    [".github/workflows/ci.yml.jinja", base("# managed\n")],
    [".github/workflows/checks.yml.jinja", base("# starter\n")],
    ["{% if not private %}CONTRIBUTING.md{% endif %}.jinja", base(`${SENTINEL}\n`)],
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

  // The scan used to derive its marker set from CURRENT declarations only.
  // .gitignore is the tree's ONLY bounded-region declaration, so flipping it
  // to managed emptied the set and disarmed the check on exactly the flip it
  // exists to catch. The constant roster is what closes that.
  test("flipping the only bounded-region declaration to managed is still caught", () => {
    const REGION = ["# BEGIN REPO-PLATFORM MANAGED", "# END REPO-PLATFORM MANAGED", ""].join("\n");
    const files = new Map<string, SourcedEntry>([[".gitignore", base(REGION)]]);
    const flipped = manifestEntries(files, skip, {
      base: [{ path: ".gitignore", class: "managed" }],
      modules: new Map(),
    });
    expect(
      flipped.errors.some((e) => e.includes("bounded-region marker but is declared managed")),
    ).toBe(true);
  });

  test("records each landed file's declared class with its render gates, sorted, self-listed", () => {
    const { entries, errors } = manifestEntries(FILES, skip, declarations());
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
        ownership: { class: "split", grammar: "tail-marker", marker: SENTINEL },
      },
    ]);
  });

  test("a landed file with no declaration is an error naming the declaration home", () => {
    const undeclaredBase = manifestEntries(
      new Map([...FILES, ["EXTRA.md.jinja", base("extra\n")]]),
      skip,
      declarations(),
    );
    expect(undeclaredBase.errors.join("\n")).toContain(
      "templates/base/EXTRA.md.jinja: lands at EXTRA.md with no ownership declaration",
    );
    expect(undeclaredBase.errors.join("\n")).toContain("templates/base/ownership.yml");
    const undeclaredModule = manifestEntries(
      new Map([...FILES, ["EXTRA.md.jinja", mod("agents", "extra\n")]]),
      skip,
      declarations(),
    );
    expect(undeclaredModule.errors.join("\n")).toContain("templates/agents/module.yml");
  });

  test("a module with no ownership list gets the same undeclared error", () => {
    const { errors } = manifestEntries(
      new Map([["EXTRA.md.jinja", mod("uv", "extra\n")]]),
      skip,
      declarations({ modules: new Map() }),
    );
    expect(errors.join("\n")).toContain("lands at EXTRA.md with no ownership declaration");
  });

  test("a declaration whose path never lands is an error", () => {
    const { errors } = manifestEntries(
      FILES,
      skip,
      declarations({
        base: [
          { path: ".github/workflows/ci.yml", class: "managed" },
          { path: ".github/workflows/checks.yml", class: "starter" },
          { path: "CONTRIBUTING.md", class: "split", grammar: "tail-marker", marker: SENTINEL },
          { path: "GHOST.md", class: "managed" },
        ],
      }),
    );
    expect(errors.join("\n")).toContain(
      "templates/base/ownership.yml: ownership declares 'GHOST.md', but no templates/base/ file lands there",
    );
  });

  test("same-path declarations disagreeing across sources are an error", () => {
    const decls = declarations();
    decls.modules.set("agents", [
      { path: "CLAUDE.md", class: "managed" },
      { path: "CONTRIBUTING.md", class: "managed" },
    ]);
    const { errors } = manifestEntries(FILES, skip, decls);
    expect(errors.join("\n")).toContain(
      "templates/base/ownership.yml and templates/agents/module.yml both declare 'CONTRIBUTING.md' but disagree",
    );
  });

  test("text contradicting the declared class is an error", () => {
    const decls = declarations();
    // ci.yml declared managed but carrying a local-section marker line.
    const files = new Map([
      ...FILES,
      [".github/workflows/ci.yml.jinja", base(`# managed\n# repo-platform:local-section\n`)],
    ]);
    const { errors } = manifestEntries(files, skip, decls);
    expect(errors.join("\n")).toContain("declared managed");
  });

  test("starter declarations and _skip_if_exists must agree in both directions", () => {
    // Declared starter, no skip pattern: error from the decoration check.
    const noSkip = manifestEntries(FILES, [], declarations());
    expect(noSkip.errors.join("\n")).toContain("no copier.yml _skip_if_exists pattern");
    // A skip pattern matching no landed path is a dead entry.
    const dead = manifestEntries(
      FILES,
      [...skip, ...skipIfExistsPatterns("_skip_if_exists:\n  - ghost-starter.yml\n")],
      declarations(),
    );
    expect(dead.errors.join("\n")).toContain(
      "_skip_if_exists pattern 'ghost-starter.yml' matches no landed template path",
    );
  });

  test("a symlink declared anything but managed is an error", () => {
    const decls = declarations();
    decls.modules.set("agents", [{ path: "CLAUDE.md", class: "starter" }]);
    const { errors } = manifestEntries(FILES, skip, decls);
    expect(errors.join("\n")).toContain("is a symlink declared starter");
  });

  test("two sources landing at one path is an error, not a duplicate key", () => {
    const files = new Map<string, SourcedEntry>([
      ["{% if not private %}X.md{% endif %}.jinja", base("a\n")],
      ["X.md.jinja", mod("agents", "b\n")],
    ]);
    const decls = declarations({
      base: [{ path: "X.md", class: "managed" }],
      modules: new Map([
        ["agents", [{ path: "X.md", class: "managed" }] as OwnershipDeclaration[]],
      ]),
    });
    const { errors } = manifestEntries(files, [], decls);
    expect(errors.join("\n")).toContain("both land at X.md");
  });

  test("a template landing at the manifest's own path collides with the self entry", () => {
    const files = new Map<string, SourcedEntry>([
      [".github/repo-platform-manifest.json.jinja", base("{}\n")],
    ]);
    const decls = declarations({
      base: [{ path: ".github/repo-platform-manifest.json", class: "managed" }],
      modules: new Map(),
    });
    const { errors } = manifestEntries(files, [], decls);
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
          grammar: "tail-marker",
          marker: "<!-- repo-platform:local-section -->",
        },
      },
      {
        path: ".gitignore",
        gates: [],
        ownership: {
          class: "split",
          grammar: "bounded-region",
          managed_begin: "# BEGIN REPO-PLATFORM MANAGED",
          managed_end: "# END REPO-PLATFORM MANAGED",
          local_begin: "# BEGIN REPOSITORY LOCAL",
          local_end: "# END REPOSITORY LOCAL",
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
        ownership: { class: "starter" },
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
    // Split entries expose their grammar next to the stamper's legacy
    // marker/managed pair, derived from it.
    expect(text).toContain(
      '"class": "split", "grammar": "tail-marker", "marker": "<!-- repo-platform:local-section -->", "managed": "above", "hash": null',
    );
    expect(text).toContain(
      '"class": "split", "grammar": "bounded-region", "marker": "# BEGIN REPO-PLATFORM MANAGED", ' +
        '"managed": "below", "managed_end": "# END REPO-PLATFORM MANAGED", ' +
        '"local_begin": "# BEGIN REPOSITORY LOCAL", "local_end": "# END REPOSITORY LOCAL", "hash": null',
    );
    expect(text).toContain("{%- if ('a' in modules) and (not private) -%}");
    // No-parity classes carry no hash token for the stamper to fill.
    expect(text).toContain(`'    "checks.yml": {"class": "starter"}'`);
    expect(text).toContain(`'    ".github/settings.yml": {"class": "starter"}'`);
    expect(text).toContain("{{ entries | join(',\\n') }}");
    expect(text.endsWith("}\n")).toBe(true);
  });
});

// The conditional-landing pieces: plain emitted names, literal exclude
// patterns, and the directory derivation. The composed tree carries no
// jinja-expression filenames (tarball extraction safety), so these are
// what realizes the gates instead.
describe("plainTemplatePath", () => {
  test("strips a filename gate, keeping the .jinja suffix outside the landed name", () => {
    expect(plainTemplatePath("{% if not private %}CONTRIBUTING.md{% endif %}.jinja")).toBe(
      "CONTRIBUTING.md.jinja",
    );
  });

  test("strips a gated directory segment", () => {
    expect(plainTemplatePath("{% if 'demo' in modules %}.demo{% endif %}/config.yml")).toBe(
      ".demo/config.yml",
    );
  });

  test("leaves plain paths untouched", () => {
    expect(plainTemplatePath(".github/workflows/ci.yml.jinja")).toBe(
      ".github/workflows/ci.yml.jinja",
    );
    expect(plainTemplatePath("CLAUDE.md")).toBe("CLAUDE.md");
  });
});

// Fail-closed filename validation: a name the composer cannot honestly
// strip (or that copier would land under a different name than the
// manifest records) is a compose error, never a silent divergence.
describe("templatePathErrors", () => {
  test("accepts plain names, recognized gates, and gated directories", () => {
    for (const ok of [
      "AGENTS.md.jinja",
      "{% if not private %}CONTRIBUTING.md{% endif %}.jinja",
      "{% if 'demo' in modules %}.demo{% endif %}/config.yml",
      ".github/workflows/ci.yml.jinja",
    ]) {
      expect(templatePathErrors(ok)).toEqual([]);
    }
  });

  test("rejects residual jinja syntax the gate-stripping does not recognize", () => {
    expect(templatePathErrors("a{#comment#}b.md.jinja").join("\n")).toContain("jinja syntax");
    expect(templatePathErrors("{{ project_slug }}.md").join("\n")).toContain("jinja syntax");
  });

  test("rejects a .jinja suffix wrapped inside the gate", () => {
    expect(
      templatePathErrors("{% if 'demo' in modules %}foo.jinja{% endif %}").join("\n"),
    ).toContain("wraps a .jinja suffix inside its filename gate");
  });

  test("rejects edge whitespace on the LANDED name, the suffix stripped first", () => {
    expect(templatePathErrors("docs /note.md").join("\n")).toContain("whitespace");
    // 'foo .jinja' has clean emitted segments but LANDS as 'foo '.
    expect(templatePathErrors("foo .jinja").join("\n")).toContain("whitespace");
    // An INTERIOR space is fine: pathspec only strips trailing whitespace.
    expect(templatePathErrors("docs/my note.md")).toEqual([]);
  });
});

describe("gitwildmatchLiteral", () => {
  test("escapes every glob metacharacter so a path can never widen into a glob", () => {
    expect(gitwildmatchLiteral("docs/a[1]*?.md")).toBe("docs/a\\[1\\]\\*\\?.md");
    expect(gitwildmatchLiteral("weird\\name")).toBe("weird\\\\name");
  });

  test("a leading ! or # cannot negate or comment the pattern away", () => {
    expect(gitwildmatchLiteral("!important.md")).toBe("\\!important.md");
    expect(gitwildmatchLiteral("#hash.md")).toBe("\\#hash.md");
    // Mid-path they carry no meaning and stay untouched.
    expect(gitwildmatchLiteral("docs/#note!.md")).toBe("docs/#note!.md");
  });
});

describe("excludePatterns", () => {
  const entry = (path: string, gates: string[]) => ({
    path,
    gates,
    ownership: { class: "managed" } as const,
  });

  test("one templated literal pattern per gated file; ungated files are never excluded", () => {
    expect(
      excludePatterns([
        entry(".github/workflows/ci.yml", []),
        entry("AGENTS.md", ["'agents' in modules"]),
      ]),
      // Root-anchored: an unanchored single-segment pattern would match at
      // any depth.
    ).toEqual(["{% if not ('agents' in modules) %}/AGENTS.md{% endif %}"]);
  });

  test("several gates and-chain (the file renders only while ALL hold)", () => {
    expect(
      excludePatterns([entry("CONTRIBUTING.md", ["'demo' in modules", "not private"])]),
    ).toEqual(["{% if not (('demo' in modules) and (not private)) %}/CONTRIBUTING.md{% endif %}"]);
  });

  test("a metacharacter path is escaped inside the pattern (never a glob over siblings)", () => {
    expect(excludePatterns([entry("docs/a[1]*.md", ["'demo' in modules"])])).toEqual([
      "{% if not ('demo' in modules) %}docs/a\\[1\\]\\*.md{% endif %}",
      // The all-gated parent directory gets its own (escaped) pattern too.
      "{% if not ('demo' in modules) %}/docs{% endif %}",
    ]);
  });

  test("a directory whose every file is gated is excluded unless some selection under it holds", () => {
    const patterns = excludePatterns([
      entry(".demo/a.json", ["'demo' in modules"]),
      entry(".demo/b.json", ["'other' in modules"]),
      entry("README.md", []),
    ]);
    expect(patterns).toContain(
      "{% if not (('demo' in modules) or ('other' in modules)) %}/.demo{% endif %}",
    );
    // A directory with any ungated file always renders: no dir pattern
    // (two file patterns plus the one .demo directory pattern).
    expect(patterns).toHaveLength(3);
  });

  test("a path that cannot ride the jinja-in-YAML wrapper is refused", () => {
    expect(() => excludePatterns([entry('bad"name.md', ["'demo' in modules"])])).toThrow(
      "double quote",
    );
    expect(() => excludePatterns([entry("bad{{name.md", ["'demo' in modules"])])).toThrow(
      "jinja expression delimiter",
    );
  });
});
