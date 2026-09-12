// Judged on the REAL module data: the checkout's files.yml, which the build branch ships verbatim.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reservedLabelNames } from "../../../.github/scripts/build-branches/branch_tree.ts";
import {
  codeqlLanguages,
  loadModuleData,
  type Module,
  outputLines,
  outputsOf,
  PlanError,
  type PlanInput,
  planCi,
  planSite,
  REQUIRED_DEFAULTS,
  readReservedLabels,
  resolvePrivate,
  selectModules,
  trackingLabels,
  weekly,
} from "../../../actions/plan/plan.ts";
import { parseRegistration, type Registration } from "../../../actions/plan/registration.ts";
import { boundedSpawnSync } from "../../shared/bounded_spawn.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const REPO_ROOT = join(import.meta.dir, "../../..");
const FILES_CONFIG = join(REPO_ROOT, "files.yml");

const FILES_DATA = loadModuleData(readFileSync(FILES_CONFIG, "utf-8"));
const MODULES = FILES_DATA.modules;

/** files.yml reduced to the modules block the plan cannot load without. */
const MINIMAL_FILES = [
  "placeholders: []",
  "files: []",
  "modules:",
  "  site: { path: docs }",
  "",
].join("\n");

/** The reserved label roster as the build branch ships it. */
function stagedReservedLabels(): string {
  const path = join(temp.dir("plan-reserved-"), "reserved-labels.yml");
  writeFileSync(
    path,
    reservedLabelNames(REPO_ROOT)
      .map((name) => `- ${JSON.stringify(name)}\n`)
      .join(""),
  );
  return path;
}
const RESERVED = readReservedLabels(stagedReservedLabels());

const PROJECT = "project: { name: Demo Project, slug: demo, description: A demo }\n";

function registration(text: string): Registration {
  const read = parseRegistration(`${text}\n${PROJECT}`);
  if ("errors" in read) throw new Error(read.errors.join("\n"));
  return read.registration;
}

function input(text: string, isPrivate = false, modules: Module[] = MODULES): PlanInput {
  return {
    registration: registration(text),
    modules,
    defaults: FILES_DATA.defaults,
    files: FILES_DATA.files,
    retired: FILES_DATA.retired,
    reservedLabels: RESERVED,
    private: isPrivate,
  };
}

describe("loadModuleData", () => {
  test("the real files.yml in its key order, with the data and defaults the plan reads", () => {
    expect(MODULES.map((m) => m.name)).toEqual([
      "bun",
      "deno",
      "uv",
      "rust",
      "site",
      "release-please",
      "pr-title",
      "fuzzer",
      "nightly",
      "custom-license",
    ]);
    const byName = new Map(MODULES.map((m) => [m.name, m]));
    expect(byName.get("bun")?.codeql_language).toBe("javascript-typescript");
    expect(byName.get("uv")?.codeql_language).toBe("python");
    expect(byName.get("rust")?.codeql_language).toBeUndefined();
    expect(byName.get("fuzzer")?.tracking_label).toMatchObject({
      key: "fuzzer",
      default: "fuzz-nightly",
    });
    expect(byName.get("site")?.tracking_label?.key).toBe("site");
    expect(FILES_DATA.defaults).toEqual({ docsPath: "docs" });
  });

  test("the minimal modules block loads; a default the plan reads going missing fails, naming the file and key", () => {
    expect(loadModuleData(MINIMAL_FILES).defaults).toEqual(FILES_DATA.defaults);
    const cases: [drop: string, replacement: string, error: string][] = [
      ["{ path: docs }", "{}", "modules.site.path: missing"],
      [
        "{ path: docs }",
        "{ tracking_label: { key: site, default: rot } }",
        "modules.site.path: missing",
      ],
    ];
    for (const [drop, replacement, error] of cases) {
      expect(MINIMAL_FILES).toContain(drop);
      const text = MINIMAL_FILES.replace(drop, replacement);
      expect(() => loadModuleData(text, "/build/files.yml")).toThrow(PlanError);
      expect(() => loadModuleData(text, "/build/files.yml")).toThrow(`/build/files.yml: ${error}`);
    }
    // Every missing default is named at once.
    const bare = "placeholders: []\nfiles: []\nmodules: {}\n";
    const problems = (() => {
      try {
        loadModuleData(bare);
      } catch (error) {
        if (error instanceof PlanError) return error.problems;
        throw error;
      }
      return [];
    })();
    expect(problems.map((problem) => problem.split(":")[1].trim())).toEqual(
      Object.values(REQUIRED_DEFAULTS).map(({ module, key }) => `modules.${module}.${key}`),
    );
  });

  test.each<[reason: string, text: string, error: string]>([
    ["a YAML parse error", "a: [\n", "files.yml: YAML parse error"],
    [
      "a modules block that is a list",
      "placeholders: []\nfiles: []\nmodules: [bun]\n",
      "files.yml: modules: ",
    ],
    [
      "a tracking label without a default",
      MINIMAL_FILES.replace(
        "modules:\n",
        "modules:\n  fuzzer: { tracking_label: { key: fuzzer } }\n",
      ),
      "files.yml: modules.fuzzer.tracking_label.default: ",
    ],
    [
      "a file entry naming a module the block lacks",
      MINIMAL_FILES.replace(
        "files: []",
        "files: [{ path: a, class: managed, when: { modules: [nope] } }]",
      ),
      "files.yml: files: a: when names unknown module 'nope'",
    ],
  ])("an invalid files.yml fails closed on %s", (_reason, text, error) => {
    expect(() => loadModuleData(text)).toThrow(PlanError);
    expect(() => loadModuleData(text)).toThrow(error);
  });
});

describe("planCi", () => {
  const MONDAY = new Date("2026-09-07T04:03:00Z");
  const THURSDAY = new Date("2026-09-10T04:03:00Z");

  test("canonical order, CodeQL per toolchain, tracking labels per stream (defaults) plus the fleet security label", () => {
    const plan = planCi(input("modules: [nightly, uv, bun, fuzzer, site, release-please]"), MONDAY);
    expect(plan).toEqual({
      modules: ["bun", "uv", "site", "release-please", "fuzzer", "nightly"],
      private: false,
      codeqlLanguages: ["javascript-typescript", "python"],
      trackingLabels: ["docs-link-rot", "fuzz-nightly", "nightly-failure", "security-nightly"],
      weekly: true,
    });
    expect(outputsOf(plan)).toEqual({
      "modules": '["bun","uv","site","release-please","fuzzer","nightly"]',
      "private": "false",
      "codeql-languages": '["javascript-typescript","python"]',
      "tracking-labels": "docs-link-rot,fuzz-nightly,nightly-failure,security-nightly",
      "weekly": "true",
    });
  });

  test("weekly is the Monday of the UTC calendar, whatever the hour", () => {
    expect(weekly(MONDAY)).toBe(true);
    expect(weekly(new Date("2026-09-07T23:59:59Z"))).toBe(true);
    expect(weekly(new Date("2026-09-08T00:00:00Z"))).toBe(false);
    expect(weekly(THURSDAY)).toBe(false);
    expect(planCi(input("modules: []"), THURSDAY).weekly).toBe(false);
  });

  test("registration labels win over the module defaults, per key", () => {
    expect(
      planCi(input("modules: [fuzzer, nightly]\nlabels:\n  nightly: nightly-red\n")),
    ).toMatchObject({
      trackingLabels: ["fuzz-nightly", "nightly-red", "security-nightly"],
    });
    expect(
      planCi(input("modules: [fuzzer, nightly]\nlabels: { fuzzer: 'fuzz: nightly' }\n")),
    ).toMatchObject({
      trackingLabels: ["fuzz: nightly", "nightly-failure", "security-nightly"],
    });
  });

  test("CodeQL is off for a private repository and where no module analyzes", () => {
    expect(planCi(input("modules: [bun, uv]", true)).codeqlLanguages).toEqual([]);
    expect(planCi(input("modules: [rust, site]")).codeqlLanguages).toEqual([]);
    // Shared language, one entry: bun and deno both analyze as JS/TS.
    expect(codeqlLanguages(selectModules(input("modules: [deno, bun]")), false)).toEqual([
      "javascript-typescript",
    ]);
  });

  test("an empty selection plans an empty repository: the fleet security label is still tracked", () => {
    expect(outputsOf(planCi(input("modules: []"), THURSDAY))).toEqual({
      "modules": "[]",
      "private": "false",
      "codeql-languages": "[]",
      "tracking-labels": "security-nightly",
      "weekly": "false",
    });
  });

  test.each<{ reason: string; text: string; error: string }>([
    {
      reason: "an unknown module name",
      text: "modules: [bun, agents]",
      error: '.repo-platform.yml: module "agents" is not a module files.yml offers',
    },
    {
      reason: "a label for a stream that is not selected",
      text: "modules: [fuzzer]\nlabels:\n  nightly: x\n",
      error:
        ".repo-platform.yml: labels.nightly names no selected tracking stream (selected: fuzzer)",
    },
    {
      reason: "two streams sharing one label",
      text: "modules: [fuzzer, nightly]\nlabels:\n  fuzzer: Same\n  nightly: same\n",
      error: 'tracking label "same" is shared by two streams',
    },
    {
      reason: "a registration label the platform manages",
      text: "modules: [fuzzer]\nlabels:\n  fuzzer: Bug\n",
      error: 'tracking label "Bug" (fuzzer) is a label the platform already manages',
    },
    {
      reason:
        "a mirror source files.yml does not write for the selection (custom-license drops LICENSE.md)",
      text: "modules: [custom-license]\nmirrors:\n  - {source: LICENSE.md, targets: [skills/*/LICENSE.md]}\n",
      error:
        ".repo-platform.yml: mirrors: source 'LICENSE.md', target 'skills/*/LICENSE.md': the source is not a managed or split file files.yml writes for this repository",
    },
    {
      reason: "a mirror target that is a path files.yml writes",
      text: "modules: [bun]\nmirrors:\n  - {source: LICENSE.md, targets: [CLAUDE.md]}\n",
      error:
        ".repo-platform.yml: mirrors: source 'LICENSE.md', target 'CLAUDE.md': the target is a path files.yml writes",
    },
    {
      reason: "a mirror target under .github/workflows/",
      text: "modules: [bun]\nmirrors:\n  - {source: LICENSE.md, targets: [.github/workflows/release.yml]}\n",
      error:
        ".repo-platform.yml: mirrors: source 'LICENSE.md', target '.github/workflows/release.yml': the target sits under .github/workflows/",
    },
    {
      reason: "two mirror targets that nest",
      text: "modules: [bun]\nmirrors:\n  - {source: LICENSE.md, targets: [copies/a, copies/a/b]}\n",
      error:
        ".repo-platform.yml: mirrors: source 'LICENSE.md', target 'copies/a': the target is a path prefix of another target 'copies/a/b'\n" +
        ".repo-platform.yml: mirrors: source 'LICENSE.md', target 'copies/a/b': the target sits under another target 'copies/a'",
    },
  ])("fails closed on $reason", ({ text, error }) => {
    expect(() => planCi(input(text))).toThrow(PlanError);
    expect(() => planCi(input(text))).toThrow(error);
  });

  test("a sound mirror declaration plans exactly like the registration without it", () => {
    const bare = "modules: [bun]\n";
    const text = `${bare}mirrors:\n  - {source: LICENSE.md, targets: [skills/*/LICENSE.md, template/LICENSE.md]}\n  - {source: AGENTS.md, targets: [skills/*/AGENTS.md]}\n`;
    expect(planCi(input(text), THURSDAY)).toEqual(planCi(input(bare), THURSDAY));
    expect(planCi(input(text), THURSDAY).modules).toEqual(["bun"]);
  });

  test("a tracking label default files.yml spells outside the label grammar fails, naming the data file", () => {
    const modules = MODULES.map((m) =>
      m.name === "fuzzer" ? { ...m, tracking_label: { key: "fuzzer", default: "-bad" } } : m,
    );
    expect(() => planCi(input("modules: [fuzzer]", false, modules))).toThrow(
      "files.yml: the fuzzer tracking label default is not a plain label: -bad",
    );
  });

  test("the reserved roster is the platform's managed labels, lowercased", () => {
    expect(RESERVED.has("bug")).toBe(true);
    expect(RESERVED.has("autorelease: pending")).toBe(true);
    expect(RESERVED.has("fuzz-nightly")).toBe(false);
    const bad = join(temp.dir("plan-reserved-bad-"), "reserved-labels.yml");
    writeFileSync(bad, "labels: [bug]\n");
    expect(() => readReservedLabels(bad)).toThrow("must be a YAML list of label names");
  });

  test("trackingLabels keeps canonical stream order whatever the selection order", () => {
    const i = input("modules: [nightly, site, fuzzer]");
    expect(trackingLabels(i, selectModules(i))).toEqual([
      "docs-link-rot",
      "fuzz-nightly",
      "nightly-failure",
    ]);
  });
});

describe("planSite", () => {
  test("the registration carries everything: the docs mount path, the title, the include roots verbatim, the label", () => {
    const include = [
      { path: "skills", mount: "skills", page: "SKILL.md" },
      { path: "guides", mount: "guides", page: "GUIDE.md" },
    ];
    const text = [
      "modules: [bun, site, fuzzer]",
      "site:",
      "  path: manual",
      "  include:",
      "    - { path: skills, mount: skills, page: SKILL.md }",
      "    - { path: guides, mount: guides, page: GUIDE.md }",
      "labels: { site: rot }",
    ].join("\n");
    expect(planSite(input(text))).toEqual({
      siteTitle: "Demo Project",
      docs: { path: "manual", include },
      linkRotLabel: "rot",
    });
    expect(outputsOf(planSite(input(text)))).toEqual({
      config: JSON.stringify({
        site_title: "Demo Project",
        docs_path: "manual",
        include,
        link_rot_label: "rot",
      }),
    });
  });

  test("a bare selection takes every default: the project name as the title, files.yml's path, no include roots, the stream's default label", () => {
    expect(outputsOf(planSite(input("modules: [site]")))).toEqual({
      config:
        '{"site_title":"Demo Project","docs_path":"docs","include":[],"link_rot_label":"docs-link-rot"}',
    });
  });

  test("site.path: null plans no docs half: the config carries a null docs_path for the website alone", () => {
    const plan = planSite(input("modules: [site]\nsite: { path: null }"));
    expect(plan).toEqual({ siteTitle: "Demo Project", docs: null, linkRotLabel: "docs-link-rot" });
    expect(outputsOf(plan)).toEqual({
      config:
        '{"site_title":"Demo Project","docs_path":null,"include":[],"link_rot_label":"docs-link-rot"}',
    });
  });

  test("fails closed when site is not selected: there is no site to deploy", () => {
    expect(() => planSite(input("modules: [bun]"))).toThrow(PlanError);
    expect(() => planSite(input("modules: [bun]"))).toThrow(
      ".repo-platform.yml: the site module is not selected - there is no site to deploy",
    );
  });
});

describe("outputLines", () => {
  test("one-line values as name=value; a multi-line value under a delimiter it cannot contain", () => {
    expect(outputLines({ a: "x", b: "" })).toBe("a=x\nb=\n");
    const text = outputLines({ note: "line one\nline two" });
    const match = /^note<<(ghadelimiter_[0-9a-f]{32})\nline one\nline two\n\1\n$/.exec(text);
    expect(match).not.toBeNull();
  });
});

describe("resolvePrivate", () => {
  test("the caller's input decides without any API call; anything else fails", () => {
    expect(resolvePrivate("true", "o/r")).toBe(true);
    expect(resolvePrivate("false", "o/r")).toBe(false);
    expect(() => resolvePrivate("yes", "o/r")).toThrow(
      "private input must be true, false, or empty",
    );
  });
});

// The script as the action runs it: a caller checkout with its
// registration, the checkout's files.yml as the build branch ships it, and
// GITHUB_OUTPUT collecting the rows.
describe("plan.ts as a child", () => {
  function run(
    files: Record<string, string>,
    env: Record<string, string>,
  ): { exitCode: number; stdout: string; output: string } {
    const root = temp.dir("plan-root-");
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    const output = join(temp.dir("plan-output-"), "output");
    writeFileSync(output, "");
    const result = boundedSpawnSync([process.execPath, join(REPO_ROOT, "actions/plan/plan.ts")], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        FILES_CONFIG,
        RESERVED_LABELS_FILE: stagedReservedLabels(),
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "o/r",
        ...env,
      },
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      output: readFileSync(output, "utf-8"),
    };
  }

  test("default mode writes the five fleet-ci rows and echoes them", () => {
    const result = run(
      { ".repo-platform.yml": `modules: [bun, fuzzer, release-please]\n${PROJECT}` },
      { PRIVATE: "false" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(
      [
        'modules=["bun","release-please","fuzzer"]',
        "private=false",
        'codeql-languages=["javascript-typescript"]',
        "tracking-labels=fuzz-nightly,security-nightly",
        `weekly=${new Date().getUTCDay() === 1}`,
        "",
      ].join("\n"),
    );
    expect(result.stdout.trimEnd()).toBe(result.output.trimEnd());
  });

  test("site mode writes the one config row without asking for the visibility", () => {
    const result = run(
      {
        ".repo-platform.yml":
          "modules: [bun, site]\nproject: { name: Site, slug: site, description: d }\nsite: { include: [{ path: skills, mount: skills, page: SKILL.md }] }\n",
      },
      { MODE: "site" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(
      'config={"site_title":"Site","docs_path":"docs","include":[{"path":"skills","mount":"skills","page":"SKILL.md"}],"link_rot_label":"docs-link-rot"}\n',
    );
  });

  test("a missing or invalid files.yml, or an unknown module, fails as a workflow error naming the file", () => {
    const missing = join(temp.dir("plan-files-missing-"), "files.yml");
    const noFile = run(
      { ".repo-platform.yml": `modules: [bun]\n${PROJECT}` },
      { PRIVATE: "false", FILES_CONFIG: missing },
    );
    expect(noFile.exitCode).toBe(1);
    expect(noFile.stdout).toContain(`::error::${missing}: cannot read the file`);
    expect(noFile.output).toBe("");
    const invalid = join(temp.dir("plan-files-invalid-"), "files.yml");
    writeFileSync(invalid, "placeholders: []\nfiles: []\nmodules: [bun]\n");
    const badBlock = run(
      { ".repo-platform.yml": `modules: [bun]\n${PROJECT}` },
      { PRIVATE: "false", FILES_CONFIG: invalid },
    );
    expect(badBlock.exitCode).toBe(1);
    expect(badBlock.stdout).toContain(`::error::${invalid}: modules: `);
    expect(badBlock.output).toBe("");
    const unknown = run(
      { ".repo-platform.yml": `modules: [bun, agents]\n${PROJECT}` },
      { PRIVATE: "false" },
    );
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stdout).toContain(
      '::error::.repo-platform.yml: module "agents" is not a module files.yml offers',
    );
    expect(unknown.output).toBe("");
  });

  test("an impossible mirror declaration fails as one workflow error per target and writes no row", () => {
    const result = run(
      {
        ".repo-platform.yml": `modules: [bun]\n${PROJECT}mirrors:\n  - {source: LICENSE.md, targets: [copies/a, copies/a/b, skills/*/LICENSE.md]}\n`,
      },
      { PRIVATE: "false" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe(
      "::error::.repo-platform.yml: mirrors: source 'LICENSE.md', target 'copies/a': the target is a path prefix of another target 'copies/a/b'\n" +
        "::error::.repo-platform.yml: mirrors: source 'LICENSE.md', target 'copies/a/b': the target sits under another target 'copies/a'\n",
    );
    expect(result.output).toBe("");
  });

  test("a missing registration, an invalid one, or an unknown mode fails as a workflow error", () => {
    const missing = run({}, { PRIVATE: "false" });
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain("::error::.repo-platform.yml: missing");
    expect(missing.output).toBe("");
    const invalid = run(
      { ".repo-platform.yml": `modules: [bun]\nnope: 1\n${PROJECT}` },
      { PRIVATE: "false" },
    );
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stdout).toContain(
      '::error::.repo-platform.yml: (top level): Unrecognized key: "nope"',
    );
    const mode = run({ ".repo-platform.yml": `modules: []\n${PROJECT}` }, { MODE: "pages" });
    expect(mode.exitCode).toBe(1);
    expect(mode.stdout).toContain("::error::MODE must be one of default, site; got 'pages'");
  });

  // Site mode reads the registration too, so a refused key fails the plan before a deploy could read it as nothing.
  test("an unknown registration key fails in both modes", () => {
    for (const env of [{ PRIVATE: "false" }, { MODE: "site" }] as Record<string, string>[]) {
      const result = run(
        { ".repo-platform.yml": `modules: [site]\npages: { build: bun run build }\n${PROJECT}` },
        env,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(
        '::error::.repo-platform.yml: (top level): Unrecognized key: "pages"',
      );
      expect(result.output).toBe("");
    }
  });

  test("every default comes from files.yml: other defaults there change the outputs, a missing one fails", () => {
    const real = readFileSync(FILES_CONFIG, "utf-8");
    const edits: [string, string][] = [["    path: docs\n", "    path: manual\n"]];
    let other = real;
    for (const [from, to] of edits) {
      expect(other).toContain(from);
      other = other.replace(from, to);
    }
    const dir = temp.dir("plan-files-other-");
    const otherPath = join(dir, "files.yml");
    writeFileSync(otherPath, other);
    const ci = run(
      { ".repo-platform.yml": `modules: [site]\n${PROJECT}` },
      { PRIVATE: "false", FILES_CONFIG: otherPath },
    );
    expect(ci.exitCode).toBe(0);
    expect(ci.output).toBe(
      [
        'modules=["site"]',
        "private=false",
        "codeql-languages=[]",
        "tracking-labels=docs-link-rot,security-nightly",
        `weekly=${new Date().getUTCDay() === 1}`,
        "",
      ].join("\n"),
    );
    const site = run(
      { ".repo-platform.yml": `modules: [bun, site]\n${PROJECT}` },
      { MODE: "site", FILES_CONFIG: otherPath },
    );
    expect(site.exitCode).toBe(0);
    expect(site.output).toBe(
      'config={"site_title":"Demo Project","docs_path":"manual","include":[],"link_rot_label":"docs-link-rot"}\n',
    );
    const missingPath = join(dir, "missing-path.yml");
    writeFileSync(missingPath, real.replace("    path: docs\n", ""));
    const missing = run(
      { ".repo-platform.yml": `modules: [bun]\n${PROJECT}` },
      { PRIVATE: "false", FILES_CONFIG: missingPath },
    );
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain(`::error::${missingPath}: modules.site.path: missing`);
    expect(missing.output).toBe("");
  });

  test("a private registration plans without CodeQL", () => {
    const result = run({ ".repo-platform.yml": `modules: [uv]\n${PROJECT}` }, { PRIVATE: "true" });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("private=true\ncodeql-languages=[]\n");
  });
});
