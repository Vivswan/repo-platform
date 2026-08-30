// Unit tests for the module-manifest loader: the zod schema's rejections
// (every interpolation-hostile string shape), the file/folder existence
// errors, the cross-manifest label-consistency check, the MODULE_ORDER <->
// templates/ integrity checks, and the MODULE_ORDER load against the live
// repo's manifests.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODULE_ORDER } from "../../scripts/compose_template";
import {
  assertConditionalWorkflowFiles,
  assertConditionalWorkflowNamesUnclaimed,
  assertConditionalWorkflowUniqueness,
  assertDependabotLabelConsistency,
  assertModuleOrderIntegrity,
  assertSettingsLayerFiles,
  assertTrackingLabelUniqueness,
  loadManifests,
  type ModuleManifest,
  parseManifest,
  readManifest,
  shippedWorkflowNames,
} from "../../scripts/module_manifests";

const WHERE = "templates/demo/module.yml";

describe("parseManifest", () => {
  test("a description-only manifest parses", () => {
    const manifest = parseManifest("demo", "description: a demo module\n", WHERE);
    expect(manifest.module).toBe("demo");
    expect(manifest.description).toBe("a demo module");
    expect(manifest.toolchain).toBeUndefined();
  });

  test("a full toolchain manifest parses with every field typed", () => {
    const manifest = parseManifest(
      "demo",
      [
        "description: demo toolchain",
        "toolchain:",
        "  codeql_language: python",
        "dependabot:",
        "  ecosystem: pip",
        "  label: python",
        '  color: "2b67c6"',
        "gitignore_sources:",
        "  - Python.gitignore",
        "lockfiles:",
        "  - 'demo\\.lock'",
        "pages:",
        "  install: demo install",
        "  build: demo build",
        "gate: \"'demo' in modules\"",
      ].join("\n"),
      WHERE,
    );
    expect(manifest.toolchain).toEqual({ codeql_language: "python" });
    expect(manifest.dependabot).toEqual({ ecosystem: "pip", label: "python", color: "2b67c6" });
    expect(manifest.lockfiles).toEqual(["demo\\.lock"]);
    expect(manifest.pages).toEqual({ install: "demo install", build: "demo build" });
    expect(manifest.gate).toBe("'demo' in modules");
  });

  test("an unknown key fails loudly, naming the file", () => {
    expect(() => parseManifest("demo", "description: x\ntoolchian: {}\n", WHERE)).toThrow(WHERE);
  });

  test("a toolchain pin parses with file and version typed", () => {
    const manifest = parseManifest(
      "demo",
      [
        "description: demo toolchain",
        "toolchain:",
        "  codeql_language: python",
        "  pin:",
        "    file: .demo-version",
        "    version: 1.2.3",
      ].join("\n"),
      WHERE,
    );
    expect(manifest.toolchain?.pin).toEqual({ file: ".demo-version", version: "1.2.3" });
  });

  test("degenerate pin file names fail: no dot, uppercase, path separators", () => {
    for (const file of ["bun-version", ".Bun-version", ".bun/version", "."]) {
      expect(() =>
        parseManifest(
          "demo",
          [
            "description: x",
            "toolchain:",
            "  codeql_language: python",
            "  pin:",
            `    file: "${file}"`,
            "    version: 1.2.3",
          ].join("\n"),
          WHERE,
        ),
      ).toThrow("dotfile");
    }
  });

  test("degenerate pin versions fail: prefixes, ranges, partial versions", () => {
    for (const version of ["v1.2.3", "1.2", "^1.2.3", "1.2.3-beta.1", "latest"]) {
      expect(() =>
        parseManifest(
          "demo",
          [
            "description: x",
            "toolchain:",
            "  codeql_language: python",
            "  pin:",
            "    file: .demo-version",
            `    version: "${version}"`,
          ].join("\n"),
          WHERE,
        ),
      ).toThrow("X.Y.Z");
    }
  });

  test("a pin missing either key fails loudly", () => {
    expect(() =>
      parseManifest(
        "demo",
        "description: x\ntoolchain:\n  codeql_language: python\n  pin:\n    file: .demo-version\n",
        WHERE,
      ),
    ).toThrow("version");
    expect(() =>
      parseManifest(
        "demo",
        "description: x\ntoolchain:\n  codeql_language: python\n  pin:\n    version: 1.2.3\n",
        WHERE,
      ),
    ).toThrow("file");
  });

  test("a toolchain without a CodeQL language is unrepresentable", () => {
    expect(() => parseManifest("demo", "description: x\ntoolchain: true\n", WHERE)).toThrow(
      "toolchain",
    );
    expect(() => parseManifest("demo", "description: x\ntoolchain: {}\n", WHERE)).toThrow(
      "codeql_language",
    );
    expect(() =>
      parseManifest("demo", "description: x\ntoolchain:\n  codeql_language: C++\n", WHERE),
    ).toThrow("CodeQL language slug");
  });

  test("degenerate CodeQL language shapes fail: leading/trailing/double dashes", () => {
    for (const language of ["-python", "go-", "a--b", "-"]) {
      expect(() =>
        parseManifest(
          "demo",
          `description: x\ntoolchain:\n  codeql_language: "${language}"\n`,
          WHERE,
        ),
      ).toThrow("CodeQL language slug");
    }
  });

  test("a missing description fails", () => {
    expect(() => parseManifest("demo", "gate: x\n", WHERE)).toThrow("description");
  });

  test("tracking-label descriptions that YAML could reinterpret bare are refused", () => {
    const withDescription = (description: string) =>
      [
        "description: x",
        "tracking_label:",
        "  answer: demo_label",
        "  default: demo-nightly",
        '  color: "B60205"',
        `  description: ${JSON.stringify(description)}`,
      ].join("\n");
    expect(() =>
      parseManifest("demo", withDescription("Automated nightly failure"), WHERE),
    ).not.toThrow();
    for (const bad of [
      "fails: often",
      "count #1",
      "'quoted'",
      '"quoted"',
      "- leading dash",
      "true",
      "123",
      "1e3",
    ]) {
      expect(() => parseManifest("demo", withDescription(bad), WHERE)).toThrow("YAML round-trip");
    }
  });

  test("interpolation-hostile descriptions fail: ': ', '#', newlines, edge whitespace", () => {
    const bad: [string, string][] = [
      ['description: "broken: choice text"', '": "'],
      ['description: "text # with a comment"', '"#"'],
      ['description: "two\\nlines"', "single line"],
      ['description: " padded "', "whitespace"],
    ];
    for (const [line, message] of bad) {
      expect(() => parseManifest("demo", `${line}\n`, WHERE)).toThrow(message);
    }
  });

  test("a colon without a following space in the description is fine", () => {
    const manifest = parseManifest("demo", 'description: "labels like python:uv work"\n', WHERE);
    expect(manifest.description).toBe("labels like python:uv work");
  });

  test("pages commands reject quotes, backslashes, and newlines (they land in Jinja quotes inside a YAML double-quoted scalar)", () => {
    const withPages = (install: string) =>
      `description: x\npages:\n  install: ${install}\n  build: demo build\n`;
    expect(() => parseManifest("demo", withPages(`"it's broken"`), WHERE)).toThrow(
      "YAML double-quoted scalar",
    );
    expect(() => parseManifest("demo", withPages(`'echo "hi"'`), WHERE)).toThrow(
      "YAML double-quoted scalar",
    );
    expect(() => parseManifest("demo", withPages(`'printf a\\tb'`), WHERE)).toThrow(
      "YAML double-quoted scalar",
    );
    expect(() => parseManifest("demo", withPages('"two\\nlines"'), WHERE)).toThrow("single line");
  });

  test("dependabot fields reject shapes that would corrupt their consumers", () => {
    const dependabot = (fields: string[]) =>
      `description: x\ndependabot:\n${fields.map((f) => `  ${f}`).join("\n")}\n`;
    expect(() =>
      parseManifest("demo", dependabot(["ecosystem: pip", "label: python"]), WHERE),
    ).toThrow("dependabot.color");
    expect(() =>
      parseManifest(
        "demo",
        dependabot(['ecosystem: "Not Valid"', "label: python", 'color: "2b67c6"']),
        WHERE,
      ),
    ).toThrow("ecosystem");
    expect(() =>
      parseManifest(
        "demo",
        dependabot(["ecosystem: pip", 'label: "has space"', 'color: "2b67c6"']),
        WHERE,
      ),
    ).toThrow("label");
    expect(() =>
      parseManifest(
        "demo",
        dependabot(["ecosystem: pip", "label: python", 'color: "2B67C6"']),
        WHERE,
      ),
    ).toThrow("hex color");
  });

  test("gitignore_sources and lockfiles entries reject newlines", () => {
    expect(() =>
      parseManifest("demo", 'description: x\ngitignore_sources:\n  - "a\\nb"\n', WHERE),
    ).toThrow("single line");
    expect(() => parseManifest("demo", 'description: x\nlockfiles:\n  - "a\\nb"\n', WHERE)).toThrow(
      "single line",
    );
  });

  test("lockfile patterns reject single quotes (they land inside Jinja quotes)", () => {
    expect(() =>
      parseManifest("demo", `description: x\nlockfiles:\n  - "it's\\\\.lock"\n`, WHERE),
    ).toThrow("Jinja quotes");
  });

  test("strings that land in markdown table cells reject pipes and backticks", () => {
    const withPages = (install: string, build = "demo build") =>
      `description: x\npages:\n  install: ${install}\n  build: ${build}\n`;
    expect(() => parseManifest("demo", withPages("demo install | tee log"), WHERE)).toThrow(
      "markdown table cell",
    );
    expect(() =>
      parseManifest("demo", withPages("demo install", "demo build `sub`"), WHERE),
    ).toThrow("markdown table cell");
    expect(() =>
      parseManifest("demo", 'description: x\ngitignore_sources:\n  - "we|rd.gitignore"\n', WHERE),
    ).toThrow("markdown table cell");
    expect(() =>
      parseManifest(
        "demo",
        'description: x\ngitignore_sources:\n  - "back`tick.gitignore"\n',
        WHERE,
      ),
    ).toThrow("markdown table cell");
  });

  test("an unquoted gate that parses as a boolean fails the string type", () => {
    expect(() => parseManifest("demo", "description: x\ngate: true\n", WHERE)).toThrow("gate");
  });

  test("gates reject jinja delimiters, #, /, \\, and newlines (they land in the exclude conditions)", () => {
    for (const piece of ["{", "}", "%", "#", "/", "\\\\"]) {
      expect(() => parseManifest("demo", `description: x\ngate: "a ${piece} b"\n`, WHERE)).toThrow(
        "_exclude conditions",
      );
    }
    expect(() => parseManifest("demo", 'description: x\ngate: "two\\nlines"\n', WHERE)).toThrow(
      "single line",
    );
  });

  test("gates keep single quotes - the default membership shape needs them", () => {
    const manifest = parseManifest(
      "demo",
      "description: x\ngate: \"'demo' in modules or not private\"\n",
      WHERE,
    );
    expect(manifest.gate).toBe("'demo' in modules or not private");
  });

  test("a non-mapping manifest fails", () => {
    expect(() => parseManifest("demo", "- just\n- a list\n", WHERE)).toThrow("YAML mapping");
  });

  test("unparsable YAML fails with the manifest path in the message", () => {
    expect(() => parseManifest("demo", "description: [broken\n", WHERE)).toThrow(WHERE);
    expect(() => parseManifest("demo", "description: [broken\n", WHERE)).toThrow(
      "YAML parse error",
    );
  });
});

describe("ownership declarations", () => {
  test("an ownership list parses with every class and grammar shape", () => {
    const manifest = parseManifest(
      "demo",
      [
        "description: a demo module",
        "ownership:",
        "  - { path: .github/workflows/demo.yml, class: managed }",
        "  - { path: .github/workflows/demo-starter.yml, class: starter }",
        "  - path: DEMO.md",
        "    class: split",
        "    grammar: tail-marker",
        '    marker: "<!-- repo-platform:local-section -->"',
        "  - path: .demoignore",
        "    class: split",
        "    grammar: bounded-region",
        '    managed_begin: "# BEGIN MANAGED"',
        '    managed_end: "# END MANAGED"',
        '    local_begin: "# BEGIN LOCAL"',
        '    local_end: "# END LOCAL"',
        "",
      ].join("\n"),
      WHERE,
    );
    expect(manifest.ownership).toEqual([
      { path: ".github/workflows/demo.yml", class: "managed" },
      { path: ".github/workflows/demo-starter.yml", class: "starter" },
      {
        path: "DEMO.md",
        class: "split",
        grammar: "tail-marker",
        marker: "<!-- repo-platform:local-section -->",
      },
      {
        path: ".demoignore",
        class: "split",
        grammar: "bounded-region",
        managed_begin: "# BEGIN MANAGED",
        managed_end: "# END MANAGED",
        local_begin: "# BEGIN LOCAL",
        local_end: "# END LOCAL",
      },
    ]);
  });

  test("an unknown class, a missing grammar, and a duplicate path are rejected", () => {
    const cases: [string, string[]][] = [
      ["unknown class", ["ownership:", "  - { path: X.md, class: bespoke }"]],
      ["split without grammar", ["ownership:", "  - { path: X.md, class: split, marker: '# m' }"]],
      [
        "duplicate path",
        ["ownership:", "  - { path: X.md, class: managed }", "  - { path: X.md, class: starter }"],
      ],
      ["empty list", ["ownership: []"]],
    ];
    for (const [, lines] of cases) {
      expect(() =>
        parseManifest("demo", ["description: a demo module", ...lines, ""].join("\n"), WHERE),
      ).toThrow(WHERE);
    }
  });
});

describe("settings_layers", () => {
  test("a declaration in stack order parses", () => {
    const manifest = parseManifest(
      "demo",
      "description: x\nsettings_layers:\n  - settings.yml\n  - settings-public.yml\n",
      WHERE,
    );
    expect(manifest.settings_layers).toEqual(["settings.yml", "settings-public.yml"]);
  });

  test("an unknown layer filename is refused", () => {
    expect(() =>
      parseManifest("demo", "description: x\nsettings_layers:\n  - settings-extra.yml\n", WHERE),
    ).toThrow(WHERE);
  });

  test("duplicates, wrong order, and an empty list are refused", () => {
    const bad = [
      "settings_layers:\n  - settings.yml\n  - settings.yml\n",
      "settings_layers:\n  - settings-public.yml\n  - settings.yml\n",
      "settings_layers: []\n",
    ];
    for (const lines of bad) {
      expect(() => parseManifest("demo", `description: x\n${lines}`, WHERE)).toThrow(WHERE);
    }
  });

  describe("assertSettingsLayerFiles holds the declaration and the tree together", () => {
    // Selecting layer files by existence alone failed OPEN: a deleted
    // templates/uv/settings.yml silently shrank the fleet render's stack
    // and the settings apply deleted that module's labels fleet-wide.
    // These run against the REAL manifests with an injected `exists`, so
    // the failure is proven without deleting anything.
    const manifests = loadManifests();
    const byModule = (module: string) => {
      const manifest = manifests.find((m) => m.module === module);
      if (!manifest) throw new Error(`no ${module} manifest`);
      return manifest;
    };

    test("a declared layer file missing from the tree is a hard error", () => {
      const exists = (path: string) =>
        !path.endsWith(join("templates", "uv", "settings.yml")) && existsSync(path);
      expect(() => assertSettingsLayerFiles(byModule("uv"), undefined, exists)).toThrow(
        "templates/uv/settings.yml: declared in templates/uv/module.yml settings_layers but missing",
      );
    });

    test("a layer file no manifest declares is refused, not silently ignored", () => {
      const exists = (path: string) =>
        path.endsWith(join("templates", "fuzzer", "settings.yml")) || existsSync(path);
      expect(() => assertSettingsLayerFiles(byModule("fuzzer"), undefined, exists)).toThrow(
        "templates/fuzzer/settings.yml: exists but templates/fuzzer/module.yml does not declare it",
      );
    });

    test("the real tree satisfies every manifest's declaration", () => {
      for (const manifest of manifests) {
        expect(() => assertSettingsLayerFiles(manifest)).not.toThrow();
      }
    });
  });

  describe("readManifest runs the cross-check on every load", () => {
    const root = mkdtempSync(join(tmpdir(), "settings-layers-"));
    const templates = join(root, "templates");
    beforeAll(() => {
      mkdirSync(join(templates, "declared"), { recursive: true });
      writeFileSync(
        join(templates, "declared", "module.yml"),
        "description: x\nsettings_layers:\n  - settings.yml\n",
      );
      writeFileSync(join(templates, "declared", "settings.yml"), "labels: []\n");
      mkdirSync(join(templates, "ghostly"));
      writeFileSync(
        join(templates, "ghostly", "module.yml"),
        "description: x\nsettings_layers:\n  - settings.yml\n",
      );
      mkdirSync(join(templates, "undeclared"));
      writeFileSync(join(templates, "undeclared", "module.yml"), "description: x\n");
      writeFileSync(join(templates, "undeclared", "settings-private.yml"), "labels: []\n");
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    test("declared and present loads", () => {
      expect(readManifest("declared", templates).settings_layers).toEqual(["settings.yml"]);
    });

    test("declared but missing fails the load", () => {
      expect(() => readManifest("ghostly", templates)).toThrow("missing from the tree");
    });

    test("present but undeclared fails the load", () => {
      expect(() => readManifest("undeclared", templates)).toThrow(
        "does not declare it in settings_layers",
      );
    });
  });
});

describe("assertDependabotLabelConsistency", () => {
  const manifest = (
    module: string,
    dependabot: NonNullable<ModuleManifest["dependabot"]>,
  ): ModuleManifest => ({ module, description: `${module} module`, dependabot });

  test("modules sharing a label with the same color pass", () => {
    expect(() =>
      assertDependabotLabelConsistency([
        manifest("bun", { ecosystem: "bun", label: "javascript", color: "168700" }),
        manifest("node", { ecosystem: "npm", label: "javascript", color: "168700" }),
      ]),
    ).not.toThrow();
  });

  test("modules sharing a label with different colors throw, naming both files", () => {
    expect(() =>
      assertDependabotLabelConsistency([
        manifest("bun", { ecosystem: "bun", label: "javascript", color: "168700" }),
        manifest("node", { ecosystem: "npm", label: "javascript", color: "000000" }),
      ]),
    ).toThrow("templates/bun/module.yml");
  });
});

describe("conditional_workflows", () => {
  const declared = (entries: string): ModuleManifest =>
    parseManifest(
      "demo",
      ["description: a demo module", `conditional_workflows: ${entries}`].join("\n"),
      WHERE,
    );

  test("a name-and-path declaration parses", () => {
    const manifest = declared("[{name: Extra Suite, path: .github/workflows/extra.yml}]");
    expect(manifest.conditional_workflows).toEqual([
      { name: "Extra Suite", path: ".github/workflows/extra.yml" },
    ]);
  });

  test("a name carrying a quote is refused (it lands inside Jinja '...' quotes)", () => {
    expect(() => declared(`[{name: "Extra's Suite", path: .github/workflows/extra.yml}]`)).toThrow(
      "must not contain",
    );
  });

  test("a name carrying jinja or YAML metacharacters is refused - the roster must be a plain literal", () => {
    for (const name of ["{{ project_name }}", "Extra {Suite}", "Extra # note", "50% Suite"]) {
      expect(() =>
        declared(`[{name: ${JSON.stringify(name)}, path: .github/workflows/extra.yml}]`),
      ).toThrow("must not contain");
    }
  });

  test("a name YAML would reinterpret is refused - GitHub registers the PARSED name: value", () => {
    for (const name of ["true", "123", "[a, b]"]) {
      expect(() =>
        declared(`[{name: ${JSON.stringify(name)}, path: .github/workflows/extra.yml}]`),
      ).toThrow("YAML round-trip");
    }
  });

  test("a path outside .github/workflows/ is refused", () => {
    expect(() => declared("[{name: Extra Suite, path: extra.yml}]")).toThrow(
      ".github/workflows/<file>.yml",
    );
  });

  test("an empty list is refused - omit the key instead", () => {
    expect(() => declared("[]")).toThrow();
  });

  describe("assertConditionalWorkflowFiles holds the declaration and the tree together", () => {
    const manifest = declared("[{name: Extra Suite, path: .github/workflows/extra.yml}]");
    const jinjaPath = join("templates", "demo", ".github", "workflows", "extra.yml.jinja");

    test("a declared workflow the module does not ship is a hard error", () => {
      expect(() => assertConditionalWorkflowFiles(manifest, undefined, () => false)).toThrow(
        "ships no .github/workflows/extra.yml",
      );
    });

    test("a shipped workflow whose name: line disagrees is a hard error", () => {
      expect(() =>
        assertConditionalWorkflowFiles(
          manifest,
          undefined,
          (path) => path.endsWith(jinjaPath),
          () => "name: Something Else\non:\n  pull_request:\n",
        ),
      ).toThrow("names itself 'Something Else'");
    });

    test("the comparison is against the YAML-parsed name: a quoted or comment-trailed line still matches", () => {
      for (const line of ['name: "Extra Suite"', "name: Extra Suite # rostered"]) {
        expect(() =>
          assertConditionalWorkflowFiles(
            manifest,
            undefined,
            (path) => path.endsWith(jinjaPath),
            () => `${line}\non:\n  pull_request:\n`,
          ),
        ).not.toThrow();
      }
    });

    test("a templated workflow name is a hard error - GitHub registers the RENDERED name", () => {
      expect(() =>
        assertConditionalWorkflowFiles(
          manifest,
          undefined,
          (path) => path.endsWith(jinjaPath),
          () => "name: {{ project_name }} Suite\non:\n  pull_request:\n",
        ),
      ).toThrow("templated");
    });

    test("a shipped workflow with no literal name: line is a hard error", () => {
      expect(() =>
        assertConditionalWorkflowFiles(
          manifest,
          undefined,
          (path) => path.endsWith(jinjaPath),
          () => "on:\n  pull_request:\n",
        ),
      ).toThrow("no literal top-level 'name:' line");
    });

    test("a matching shipped workflow passes, through the .jinja fallback", () => {
      expect(() =>
        assertConditionalWorkflowFiles(
          manifest,
          undefined,
          (path) => path.endsWith(jinjaPath),
          () => "name: Extra Suite\non:\n  pull_request:\n",
        ),
      ).not.toThrow();
    });
  });

  describe("assertConditionalWorkflowUniqueness", () => {
    const withWorkflows = (
      module: string,
      names: string[],
      path = ".github/workflows/extra.yml",
    ): ModuleManifest => ({
      module,
      description: `${module} module`,
      conditional_workflows: names.map((name) => ({ name, path })),
    });

    test("distinct names across modules pass", () => {
      expect(() =>
        assertConditionalWorkflowUniqueness([
          withWorkflows("demo", ["Extra Suite"]),
          withWorkflows("other", ["Other Suite"], ".github/workflows/other.yml"),
        ]),
      ).not.toThrow();
    });

    test("a name two modules claim throws, naming both files - the verdict fails closed on two claimants at run time", () => {
      expect(() =>
        assertConditionalWorkflowUniqueness([
          withWorkflows("demo", ["Extra Suite"]),
          withWorkflows("other", ["Extra Suite"], ".github/workflows/other.yml"),
        ]),
      ).toThrow("templates/demo/module.yml");
    });

    test("a name declared twice within one module throws too", () => {
      expect(() =>
        assertConditionalWorkflowUniqueness([
          withWorkflows("demo", ["Extra Suite", "Extra Suite"]),
        ]),
      ).toThrow("exactly one owner");
    });
  });

  describe("assertConditionalWorkflowNamesUnclaimed", () => {
    const withWorkflow = (module: string, name: string, path: string): ModuleManifest => ({
      module,
      description: `${module} module`,
      conditional_workflows: [{ name, path }],
    });

    test("a declared name claimed only by its own shipped file passes (plain or .jinja)", () => {
      for (const source of [
        "templates/demo/.github/workflows/extra.yml",
        "templates/demo/.github/workflows/extra.yml.jinja",
      ]) {
        expect(() =>
          assertConditionalWorkflowNamesUnclaimed(
            [withWorkflow("demo", "Extra Suite", ".github/workflows/extra.yml")],
            [
              { name: "Extra Suite", source },
              { name: "CI", source: "templates/base/.github/workflows/ci.yml.jinja" },
            ],
          ),
        ).not.toThrow();
      }
    });

    test("a declared name that is also an UNDECLARED shipped workflow's name throws - base CI is the obvious trap", () => {
      expect(() =>
        assertConditionalWorkflowNamesUnclaimed(
          [withWorkflow("demo", "CI", ".github/workflows/extra.yml")],
          [
            { name: "CI", source: "templates/demo/.github/workflows/extra.yml.jinja" },
            { name: "CI", source: "templates/base/.github/workflows/ci.yml.jinja" },
          ],
        ),
      ).toThrow("templates/base/.github/workflows/ci.yml.jinja");
    });

    test("the live tree has no claim collisions for any current declaration", () => {
      const manifests = loadManifests();
      expect(() =>
        assertConditionalWorkflowNamesUnclaimed(manifests, shippedWorkflowNames()),
      ).not.toThrow();
    });

    test("shippedWorkflowNames reads effective names off the live tree (CI and All Green are known)", () => {
      const names = shippedWorkflowNames().map((wf) => wf.name);
      expect(names).toContain("CI");
      expect(names).toContain("All Green");
    });
  });
});

describe("assertTrackingLabelUniqueness", () => {
  const manifest = (
    module: string,
    tracking_label: NonNullable<ModuleManifest["tracking_label"]>,
  ): ModuleManifest => ({ module, description: `${module} module`, tracking_label });
  const tracking = (answer: string, def: string) => ({
    answer,
    default: def,
    color: "B60205",
    description: "x",
  });

  test("distinct answers and defaults pass", () => {
    expect(() =>
      assertTrackingLabelUniqueness([
        manifest("fuzzer", tracking("fuzzer_label", "fuzz-nightly")),
        manifest("nightly", tracking("nightly_label", "nightly-failure")),
      ]),
    ).not.toThrow();
  });

  test("a shared default throws, naming both files", () => {
    expect(() =>
      assertTrackingLabelUniqueness([
        manifest("fuzzer", tracking("fuzzer_label", "nightly")),
        manifest("nightly", tracking("nightly_label", "nightly")),
      ]),
    ).toThrow("templates/fuzzer/module.yml");
  });

  test("defaults differing only in case still collide (GitHub dedups labels case-insensitively)", () => {
    expect(() =>
      assertTrackingLabelUniqueness([
        manifest("fuzzer", tracking("fuzzer_label", "Fuzz-Nightly")),
        manifest("nightly", tracking("nightly_label", "fuzz-nightly")),
      ]),
    ).toThrow("case-insensitive");
  });

  test("a shared answer key throws", () => {
    expect(() =>
      assertTrackingLabelUniqueness([
        manifest("fuzzer", tracking("shared_label", "a")),
        manifest("nightly", tracking("shared_label", "b")),
      ]),
    ).toThrow("answer 'shared_label'");
  });
});

describe("readManifest", () => {
  const root = mkdtempSync(join(tmpdir(), "module-manifests-"));
  const templates = join(root, "templates");
  beforeAll(() => {
    mkdirSync(join(templates, "demo"), { recursive: true });
    writeFileSync(join(templates, "demo", "module.yml"), "description: a demo module\n");
    mkdirSync(join(templates, "bare"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("reads a manifest from its module folder", () => {
    expect(readManifest("demo", templates).description).toBe("a demo module");
  });

  test("a missing module folder fails loudly", () => {
    expect(() => readManifest("ghost", templates)).toThrow("templates/ghost/ does not exist");
  });

  test("a folder without module.yml fails loudly", () => {
    expect(() => readManifest("bare", templates)).toThrow("templates/bare/module.yml is missing");
  });

  test("a module name unsafe for gates, YAML, or table cells fails loudly", () => {
    for (const name of ["Demo", "de|mo", "de mo", "3demo", "de`mo"]) {
      expect(() => readManifest(name, templates)).toThrow("must match");
    }
  });
});

describe("assertModuleOrderIntegrity", () => {
  const root = mkdtempSync(join(tmpdir(), "module-order-"));
  const templates = join(root, "templates");
  beforeAll(() => {
    for (const module of MODULE_ORDER) {
      mkdirSync(join(templates, module), { recursive: true });
      writeFileSync(join(templates, module, "module.yml"), `description: the ${module} module\n`);
    }
    mkdirSync(join(templates, "base"));
    writeFileSync(join(templates, "README.md"), "not a module folder\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("the live shape passes: every folder listed, base and files skipped", () => {
    expect(() => assertModuleOrderIntegrity(MODULE_ORDER, templates)).not.toThrow();
  });

  test("a duplicate order entry throws", () => {
    expect(() => assertModuleOrderIntegrity([...MODULE_ORDER, "bun"], templates)).toThrow(
      "more than once",
    );
  });

  test("a templates/ folder outside the order throws", () => {
    expect(() =>
      assertModuleOrderIntegrity(
        MODULE_ORDER.filter((module) => module !== "uv"),
        templates,
      ),
    ).toThrow("templates/uv/ is not a known module");
  });

  test("loadManifests inherits the integrity checks", () => {
    mkdirSync(join(templates, "stray-module"));
    expect(() => loadManifests(templates)).toThrow("templates/stray-module/ is not a known module");
    rmSync(join(templates, "stray-module"), { recursive: true });
    expect(loadManifests(templates).map((m) => m.module)).toEqual(MODULE_ORDER);
  });
});

describe("loadManifests (live repo)", () => {
  test("returns every module's manifest in MODULE_ORDER", () => {
    const manifests = loadManifests();
    expect(manifests.map((m) => m.module)).toEqual(MODULE_ORDER);
  });

  test("the toolchain facts match the modules that declare them", () => {
    const byModule = new Map(loadManifests().map((m) => [m.module, m]));
    expect(byModule.get("bun")?.toolchain?.codeql_language).toBe("javascript-typescript");
    // The pinned versions themselves move weekly (refresh-toolchains); only
    // the stable file names are asserted here.
    expect(byModule.get("bun")?.toolchain?.pin?.file).toBe(".bun-version");
    expect(byModule.get("node")?.toolchain?.pin?.file).toBe(".node-version");
    expect(byModule.get("deno")?.toolchain?.pin?.file).toBe(".dvmrc");
    expect(byModule.get("uv")?.toolchain).toEqual({ codeql_language: "python" });
    // Deliberate: rust contributes no CodeQL language and no auto-format
    // command (copier.yml's has_toolchain comment).
    expect(byModule.get("rust")?.toolchain).toBeUndefined();
    expect(byModule.get("agents")?.toolchain).toBeUndefined();
  });
});
