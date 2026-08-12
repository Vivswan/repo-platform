// Unit tests for the module-manifest loader: the zod schema's rejections
// (every interpolation-hostile string shape), the file/folder existence
// errors, the cross-manifest label-consistency check, the MODULE_ORDER <->
// templates/ integrity checks, and the MODULE_ORDER load against the live
// repo's manifests.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODULE_ORDER } from "../../scripts/compose_template";
import {
  assertDependabotLabelConsistency,
  assertModuleOrderIntegrity,
  assertTrackingLabelUniqueness,
  loadManifests,
  type ModuleManifest,
  parseManifest,
  readManifest,
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
        "gate_dirs:",
        "  - .github/DEMO",
      ].join("\n"),
      WHERE,
    );
    expect(manifest.toolchain).toEqual({ codeql_language: "python" });
    expect(manifest.dependabot).toEqual({ ecosystem: "pip", label: "python", color: "2b67c6" });
    expect(manifest.lockfiles).toEqual(["demo\\.lock"]);
    expect(manifest.pages).toEqual({ install: "demo install", build: "demo build" });
    expect(manifest.gate_dirs).toEqual([".github/DEMO"]);
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

  test("gates reject jinja delimiters, #, /, \\, and newlines (they land in filename gates)", () => {
    for (const piece of ["{", "}", "%", "#", "/", "\\\\"]) {
      expect(() => parseManifest("demo", `description: x\ngate: "a ${piece} b"\n`, WHERE)).toThrow(
        "filename gates",
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
