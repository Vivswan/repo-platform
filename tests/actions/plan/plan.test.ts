// The plan action's resolution, judged on the REAL module data (the
// checkout's files.yml, which the build branch ships verbatim) plus
// synthetic rows for the fail-closed edges, and the script itself run as a
// child the way the action runs it.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  callerConfiguredPages,
  codeqlLanguages,
  defaultCommands,
  defaultSetup,
  loadModuleData,
  type Module,
  outputLines,
  outputsOf,
  PlanError,
  type PlanInput,
  planCi,
  planPages,
  readReservedLabels,
  resolvePrivate,
  selectModules,
  setupProblem,
  trackingLabels,
  weekly,
} from "../../../actions/plan/plan.ts";
import { parseRegistration, type Registration } from "../../../actions/plan/registration.ts";
import { reservedLabelNames } from "../../../scripts/generate/copier_questions.ts";
import { loadManifests } from "../../../scripts/lib/module_manifests.ts";
import { boundedSpawnSync } from "../../shared/bounded_spawn.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const REPO_ROOT = join(import.meta.dir, "../../..");
const FILES_CONFIG = join(REPO_ROOT, "files.yml");

const TEMPLATE = loadModuleData(readFileSync(FILES_CONFIG, "utf-8"));
const MODULES = TEMPLATE.modules;

/** files.yml reduced to the modules block the plan cannot load without. */
const MINIMAL_FILES = [
  "placeholders: []",
  "files: []",
  "modules:",
  "  skills: { skills_dir: { default: skills } }",
  "  pages: { dist: dist }",
  "  docs-site: { path: docs }",
  "",
].join("\n");

/** The reserved label roster as the build branch ships it. */
function stagedReservedLabels(): string {
  const path = join(temp.dir("plan-reserved-"), "reserved-labels.yml");
  writeFileSync(
    path,
    reservedLabelNames(loadManifests())
      .map((name) => `- ${JSON.stringify(name)}\n`)
      .join(""),
  );
  return path;
}
const RESERVED = readReservedLabels(stagedReservedLabels());

function registration(text: string): Registration {
  const read = parseRegistration(text);
  if ("errors" in read) throw new Error(read.errors.join("\n"));
  return read.registration;
}

function input(
  text: string,
  answers: Record<string, unknown> = {},
  isPrivate = false,
  modules: Module[] = MODULES,
): PlanInput {
  return {
    registration: registration(text),
    answers,
    modules,
    defaults: TEMPLATE.defaults,
    reservedLabels: RESERVED,
    private: isPrivate,
  };
}

describe("loadModuleData", () => {
  test("the real files.yml in its key order, with the data and defaults the plan reads", () => {
    expect(MODULES.map((m) => m.name)).toEqual([
      "bun",
      "node",
      "deno",
      "uv",
      "rust",
      "pages",
      "docs-site",
      "release-please",
      "issue-templates",
      "skills",
      "pr-title",
      "fuzzer",
      "nightly",
      "custom-license",
    ]);
    const byName = new Map(MODULES.map((m) => [m.name, m]));
    expect(byName.get("bun")?.codeql_language).toBe("javascript-typescript");
    expect(byName.get("uv")?.codeql_language).toBe("python");
    expect(byName.get("rust")?.codeql_language).toBeUndefined();
    expect(byName.get("rust")?.pages).toEqual({
      install: "cargo +stable install mdbook --locked",
      build: "mdbook build -d dist",
    });
    expect(byName.get("fuzzer")?.tracking_label).toMatchObject({
      key: "fuzzer",
      default: "fuzz-nightly",
    });
    expect(byName.get("docs-site")?.tracking_label?.key).toBe("docs_site");
    expect(TEMPLATE.defaults).toEqual({ skillsDir: "skills", pagesDist: "dist", docsPath: "docs" });
  });

  test("the minimal modules block loads; a default the plan reads going missing fails, naming the file and key", () => {
    expect(loadModuleData(MINIMAL_FILES).defaults).toEqual(TEMPLATE.defaults);
    const cases: [drop: string, replacement: string, error: string][] = [
      ["  pages: { dist: dist }\n", "", "modules.pages.dist: missing"],
      ["  docs-site: { path: docs }\n", "", "modules.docs-site.path: missing"],
      ["{ skills_dir: { default: skills } }", "{}", "modules.skills.skills_dir.default: missing"],
    ];
    for (const [drop, replacement, error] of cases) {
      expect(MINIMAL_FILES).toContain(drop);
      const text = MINIMAL_FILES.replace(drop, replacement);
      expect(() => loadModuleData(text, "/build/files.yml")).toThrow(PlanError);
      expect(() => loadModuleData(text, "/build/files.yml")).toThrow(`/build/files.yml: ${error}`);
    }
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
      "a pages block without a build command",
      MINIMAL_FILES.replace("modules:\n", "modules:\n  bun: { pages: { install: bun install } }\n"),
      "files.yml: modules.bun.pages.build: ",
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
    const plan = planCi(
      input("modules: [nightly, uv, bun, fuzzer, docs-site, release-please]"),
      MONDAY,
    );
    expect(plan).toEqual({
      modules: ["bun", "uv", "docs-site", "release-please", "fuzzer", "nightly"],
      private: false,
      skillsDir: "skills",
      codeqlLanguages: ["javascript-typescript", "python"],
      trackingLabels: ["docs-link-rot", "fuzz-nightly", "nightly-failure", "security-nightly"],
      weekly: true,
    });
    expect(outputsOf(plan)).toEqual({
      "modules": '["bun","uv","docs-site","release-please","fuzzer","nightly"]',
      "private": "false",
      "skills-dir": "skills",
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

  test("recorded answers win over defaults; a registration value stands in for an absent answer", () => {
    const answers = {
      skills_dir: "lib/skills",
      fuzzer_label: "fuzz: nightly",
      nightly_label: "night",
    };
    expect(planCi(input("modules: [skills, fuzzer, nightly]", answers))).toMatchObject({
      skillsDir: "lib/skills",
      trackingLabels: ["fuzz: nightly", "night", "security-nightly"],
    });
    const text =
      "modules: [skills, fuzzer, nightly]\nskills:\n  dir: agents\nlabels:\n  nightly: nightly-red\n";
    expect(planCi(input(text, { fuzzer_label: "fuzz: nightly" }))).toMatchObject({
      skillsDir: "agents",
      trackingLabels: ["fuzz: nightly", "nightly-red", "security-nightly"],
    });
    // Both agreeing is fine: the same value from two sources is one identity.
    expect(
      planCi(input(text, { skills_dir: "agents", nightly_label: "nightly-red" })),
    ).toMatchObject({
      skillsDir: "agents",
      trackingLabels: ["fuzz-nightly", "nightly-red", "security-nightly"],
    });
  });

  test("CodeQL is off for a private repository and where no module analyzes", () => {
    expect(planCi(input("modules: [bun, uv]", {}, true)).codeqlLanguages).toEqual([]);
    expect(planCi(input("modules: [rust, pages]")).codeqlLanguages).toEqual([]);
    // Shared language, one entry: bun and node both analyze as JS/TS.
    expect(codeqlLanguages(selectModules(input("modules: [node, bun]")), false)).toEqual([
      "javascript-typescript",
    ]);
  });

  test("an empty selection plans an empty repository: the fleet security label is still tracked", () => {
    expect(outputsOf(planCi(input("modules: []"), THURSDAY))).toEqual({
      "modules": "[]",
      "private": "false",
      "skills-dir": "skills",
      "codeql-languages": "[]",
      "tracking-labels": "security-nightly",
      "weekly": "false",
    });
  });

  test.each<{ reason: string; text: string; answers?: Record<string, unknown>; error: string }>([
    {
      reason: "an unknown module name",
      text: "modules: [bun, agents]",
      error: '.repo-platform.yml: module "agents" is not a module this template offers',
    },
    {
      reason: "a label for a stream that is not selected",
      text: "modules: [fuzzer]\nlabels:\n  nightly: x\n",
      error:
        ".repo-platform.yml: labels.nightly names no selected tracking stream (selected: fuzzer)",
    },
    {
      reason: "a recorded label that is not a plain label",
      text: "modules: [fuzzer]",
      answers: { fuzzer_label: "-bad" },
      error: ".github/.copier-answers.yml: fuzzer_label is not a plain label: -bad",
    },
    {
      reason: "a recorded answer of the wrong type",
      text: "modules: [skills]",
      answers: { skills_dir: 3 },
      error: ".github/.copier-answers.yml: skills_dir must be a string",
    },
    {
      reason: "a blank recorded answer (null is a value, not an absence)",
      text: "modules: [fuzzer]",
      answers: { fuzzer_label: null },
      error: ".github/.copier-answers.yml: fuzzer_label must be a string",
    },
    {
      reason: "a registration value disagreeing with the recorded answer",
      text: "modules: [docs-site]\nlabels:\n  docs_site: rot\n",
      answers: { docs_site_label: "docs-link-rot" },
      error:
        '.repo-platform.yml: labels.docs_site is "rot" but .github/.copier-answers.yml records docs_site_label: "docs-link-rot"; the two must agree while both exist',
    },
    {
      reason: "a registration skills dir disagreeing with the recorded answer",
      text: "modules: [skills]\nskills: { dir: agents }\n",
      answers: { skills_dir: "skills" },
      error:
        '.repo-platform.yml: skills.dir is "agents" but .github/.copier-answers.yml records skills_dir: "skills"',
    },
    {
      reason: "two streams sharing one label",
      text: "modules: [fuzzer, nightly]\nlabels:\n  fuzzer: Same\n  nightly: same\n",
      error: 'tracking label "same" is shared by two streams',
    },
    {
      reason: "a registration label the template manages (copier refuses the same answer)",
      text: "modules: [fuzzer]\nlabels:\n  fuzzer: Bug\n",
      error: 'tracking label "Bug" (fuzzer) is a label the template already manages',
    },
    {
      reason: "a recorded label the template manages",
      text: "modules: [nightly]",
      answers: { nightly_label: "dependencies" },
      error: 'tracking label "dependencies" (nightly) is a label the template already manages',
    },
  ])("fails closed on $reason", ({ text, answers, error }) => {
    expect(() => planCi(input(text, answers))).toThrow(PlanError);
    expect(() => planCi(input(text, answers))).toThrow(error);
  });

  test("the reserved roster is the template's managed labels, lowercased (the copier validators' list)", () => {
    expect(RESERVED.has("bug")).toBe(true);
    expect(RESERVED.has("autorelease: pending")).toBe(true);
    expect(RESERVED.has("fuzz-nightly")).toBe(false);
    const bad = join(temp.dir("plan-reserved-bad-"), "reserved-labels.yml");
    writeFileSync(bad, "labels: [bug]\n");
    expect(() => readReservedLabels(bad)).toThrow("must be a YAML list of label names");
  });

  test("trackingLabels keeps canonical stream order whatever the selection order", () => {
    const i = input("modules: [nightly, docs-site, fuzzer]");
    expect(trackingLabels(i, selectModules(i))).toEqual([
      "docs-link-rot",
      "fuzz-nightly",
      "nightly-failure",
    ]);
  });
});

describe("planPages", () => {
  test("pages with docs-site: the website unversioned at /, the docs mount versioned", () => {
    const answers = {
      project_name: "My Project",
      pages_setup: "bun",
      pages_install_command: "bun install --frozen-lockfile",
      pages_build_command: "bun run build",
      pages_dist_dir: "dist",
      docs_site_path: "docs",
      docs_site_label: "docs-link-rot",
    };
    expect(outputsOf(planPages(input("modules: [bun, pages, docs-site]", answers)))).toEqual({
      mounts:
        '[{"path":"/","source":"command","versioned":false},{"path":"/docs/","source":"vitepress","versioned":true}]',
      setup: "bun",
      install_command: "bun install --frozen-lockfile",
      build_command: "bun run build",
      dist_dir: "dist",
      site_title: "My Project",
      docs_dir: "docs",
      link_rot_label: "docs-link-rot",
    });
  });

  test("pages alone: one versioned command mount, no title, no link-rot label", () => {
    const answers = {
      pages_setup: "deno",
      pages_install_command: "deno ci",
      pages_build_command: "deno task build",
      pages_dist_dir: "out",
    };
    expect(outputsOf(planPages(input("modules: [deno, pages]", answers)))).toEqual({
      mounts: '[{"path":"/","source":"command","versioned":true}]',
      setup: "deno",
      install_command: "deno ci",
      build_command: "deno task build",
      dist_dir: "out",
      site_title: "",
      docs_dir: "docs",
      link_rot_label: "",
    });
  });

  test("docs-site with no project name anywhere: an empty title, which pages-site fills with the repository name", () => {
    expect(planPages(input("modules: [docs-site]")).siteTitle).toBe("");
    expect(planPages(input("modules: [docs-site]", { project_name: "" })).siteTitle).toBe("");
  });

  test("docs_site.include rides on the vitepress mount verbatim, in both mount shapes", () => {
    const include = [
      { path: "skills", mount: "skills", page: "SKILL.md" },
      { path: "guides", mount: "guides" },
    ];
    const text = [
      "modules: [docs-site]",
      "project: { name: Site, slug: site, description: d }",
      "docs_site:",
      "  include:",
      "    - { path: skills, mount: skills, page: SKILL.md }",
      "    - { path: guides, mount: guides }",
    ].join("\n");
    expect(outputsOf(planPages(input(text))).mounts).toBe(
      JSON.stringify([{ path: "/", source: "vitepress", versioned: true, include }]),
    );
    const withPages = `${text.replace("[docs-site]", "[pages, docs-site]")}\npages: { setup: none, build: ./build.sh }`;
    expect(planPages(input(withPages)).mounts).toEqual([
      { path: "/", source: "command", versioned: false },
      { path: "/docs/", source: "vitepress", versioned: true, include },
    ]);
    // Without the key the mount carries no include at all (pages-site's
    // default), rather than an empty list.
    expect(planPages(input("modules: [docs-site]")).mounts).toEqual([
      { path: "/", source: "vitepress", versioned: true },
    ]);
  });

  test("docs-site alone: one versioned vitepress mount at the root, no toolchain", () => {
    const answers = { project_name: "Docs Only", docs_site_label: "rot" };
    expect(outputsOf(planPages(input("modules: [docs-site]", answers)))).toEqual({
      mounts: '[{"path":"/","source":"vitepress","versioned":true}]',
      setup: "none",
      install_command: "",
      build_command: "",
      dist_dir: "dist",
      site_title: "Docs Only",
      docs_dir: "docs",
      link_rot_label: "rot",
    });
  });

  test("the v2 registration carries everything; the defaults derive from the selected toolchains", () => {
    const text = [
      "modules: [uv, rust, pages, docs-site]",
      "project: { name: Site, slug: site, description: d }",
      "docs_site: { path: manual }",
      "labels: { docs_site: rot }",
    ].join("\n");
    // Default setup: every selected toolchain module in canonical order; the
    // commands come from the first token's module (uv before rust).
    expect(planPages(input(text))).toMatchObject({
      mounts: [
        { path: "/", source: "command", versioned: false },
        { path: "/manual/", source: "vitepress", versioned: true },
      ],
      setup: "uv,rust",
      installCommand: "uv sync",
      buildCommand: "uv run mkdocs build --site-dir dist",
      distDir: "dist",
      siteTitle: "Site",
      linkRotLabel: "rot",
    });
    // Declared setup narrows the token whose module supplies the defaults.
    const declared = `${text}\npages: { setup: rust, dist: book }`;
    expect(planPages(input(declared))).toMatchObject({
      setup: "rust",
      installCommand: "cargo +stable install mdbook --locked",
      buildCommand: "mdbook build -d dist",
      distDir: "book",
    });
    // An explicit empty install skips the install, as copier's answer does.
    expect(
      planPages(input(`${text}\npages: { install: "", build: ./build.sh, setup: none }`)),
    ).toMatchObject({
      setup: "none",
      installCommand: "",
      buildCommand: "./build.sh",
    });
  });

  test.each<{ reason: string; text: string; answers?: Record<string, unknown>; error: string }>([
    {
      reason: "neither pages nor docs-site",
      text: "modules: [bun]",
      error: "neither pages nor docs-site is selected - there is no site to deploy",
    },
    {
      reason: "pages with no build command anywhere",
      text: "modules: [pages]",
      error: "the pages module needs a build command",
    },
    {
      reason: "a setup token that is not a toolchain",
      text: "modules: [bun, pages]\npages: { setup: 'bun,ruby', build: x }",
      error: "invalid setup token 'ruby'",
    },
    {
      reason: "none combined with a toolchain",
      text: "modules: [bun, pages]\npages: { setup: 'none,bun', build: x }",
      error: "setup 'none' cannot be combined with toolchain tokens",
    },
    {
      reason: "a recorded setup with spaces",
      text: "modules: [bun, pages]",
      answers: { pages_setup: "bun, node", pages_build_command: "x" },
      error: "invalid setup value 'bun, node'",
    },
    {
      reason: "a registration build command disagreeing with the recorded answer",
      text: "modules: [bun, pages]\npages: { build: bun run site }",
      answers: { pages_build_command: "bun run build" },
      error:
        '.repo-platform.yml: pages.build is "bun run site" but .github/.copier-answers.yml records pages_build_command: "bun run build"',
    },
    {
      reason: "a registration project name disagreeing with the recorded answer",
      text: "modules: [docs-site]\nproject: { name: New, slug: new, description: d }",
      answers: { project_name: "Old" },
      error:
        '.repo-platform.yml: project.name is "New" but .github/.copier-answers.yml records project_name: "Old"',
    },
  ])("fails closed on $reason", ({ text, answers, error }) => {
    expect(() => planPages(input(text, answers))).toThrow(error);
  });
});

describe("setupProblem (the grammar the shared deploy used to check in shell)", () => {
  const TOKENS = ["bun", "node", "deno", "uv", "rust"];
  test.each([
    ["none", null],
    ["bun", null],
    ["bun,rust", null],
    ["", "invalid setup value ''"],
    ["bun,", "invalid setup value 'bun,'"],
    [",bun", "invalid setup value ',bun'"],
    ["bun,,rust", "invalid setup value 'bun,,rust'"],
    ["Bun", "invalid setup value 'Bun'"],
    ["bun,bun", "duplicate setup token 'bun'"],
    ["bun,none", "setup 'none' cannot be combined with toolchain tokens"],
    ["bunx", "invalid setup token 'bunx'"],
  ])("%p -> %p", (setup, problem) => {
    const actual = setupProblem(setup, TOKENS);
    if (problem === null) expect(actual).toBeNull();
    else expect(actual).toStartWith(problem);
  });

  test("defaultSetup joins the selected toolchain modules, or none", () => {
    expect(defaultSetup(selectModules(input("modules: [rust, bun, pages]")))).toBe("bun,rust");
    expect(defaultSetup(selectModules(input("modules: [pages]")))).toBe("none");
  });

  test("the command defaults follow the setup tokens across ALL modules, as copier derives them", () => {
    // setup may name a toolchain the selection does not carry: copier's
    // pages_install_command default keys on pages_setup alone.
    expect(defaultCommands(MODULES, "bun,node")).toEqual({
      install: "bun install --frozen-lockfile",
      build: "bun run build",
    });
    expect(defaultCommands(MODULES, "none")).toEqual({ install: "", build: "" });
    expect(planPages(input("modules: [node, pages]\npages: { setup: 'bun,node' }"))).toMatchObject({
      installCommand: "bun install --frozen-lockfile",
      buildCommand: "bun run build",
    });
    expect(planPages(input("modules: [pages]\npages: { setup: bun }"))).toMatchObject({
      buildCommand: "bun run build",
    });
  });
});

describe("callerConfiguredPages", () => {
  const caller = {
    mounts: '[{"path": "/", "source": "vitepress", "versioned": true}]',
    setup: "none",
    installCommand: "",
    buildCommand: "",
    distDir: "dist",
    siteTitle: "T",
    docsDir: "docs",
    linkRotLabel: "",
  };
  test("publishes the caller's values unchanged, mounts included", () => {
    expect(outputsOf(callerConfiguredPages(caller, MODULES))).toEqual({
      mounts: caller.mounts,
      setup: "none",
      install_command: "",
      build_command: "",
      dist_dir: "dist",
      site_title: "T",
      docs_dir: "docs",
      link_rot_label: "",
    });
  });
  test("checks the setup grammar the way a planned deploy is checked", () => {
    expect(() => callerConfiguredPages({ ...caller, setup: "bun,bun" }, MODULES)).toThrow(
      "setup input: duplicate setup token 'bun'",
    );
    expect(() => callerConfiguredPages({ ...caller, setup: "bun,none" }, MODULES)).toThrow(
      "cannot be combined",
    );
  });
});

describe("outputLines", () => {
  test("one-line values as name=value; a multi-line value under a delimiter it cannot contain", () => {
    expect(outputLines({ a: "x", b: "" })).toBe("a=x\nb=\n");
    const text = outputLines({ build_command: "bun run generate\nbun run build" });
    const match =
      /^build_command<<(ghadelimiter_[0-9a-f]{32})\nbun run generate\nbun run build\n\1\n$/.exec(
        text,
      );
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

// The script as the action runs it: a caller checkout with the two files,
// the checkout's files.yml as the build branch ships it, and GITHUB_OUTPUT
// collecting the rows.
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

  const ANSWERS =
    "_commit: abc\nproject_name: Demo\nskills_dir: skills\nfuzzer_label: fuzz-nightly\n";

  test("default mode writes the six fleet-ci rows and echoes them", () => {
    const result = run(
      {
        ".repo-platform.yml": "modules: [bun, fuzzer, release-please]\n",
        ".github/.copier-answers.yml": ANSWERS,
      },
      { PRIVATE: "false" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(
      [
        'modules=["bun","release-please","fuzzer"]',
        "private=false",
        "skills-dir=skills",
        'codeql-languages=["javascript-typescript"]',
        "tracking-labels=fuzz-nightly,security-nightly",
        `weekly=${new Date().getUTCDay() === 1}`,
        "",
      ].join("\n"),
    );
    expect(result.stdout.trimEnd()).toBe(result.output.trimEnd());
  });

  test("pages mode writes the eight deploy rows", () => {
    const result = run(
      {
        ".repo-platform.yml": "modules: [bun, pages]\n",
        ".github/.copier-answers.yml": `${ANSWERS}pages_setup: bun\npages_build_command: bun run build\n`,
      },
      { MODE: "pages" },
    );
    expect(result.exitCode).toBe(0);
    // No recorded install command: the setup token's module supplies it.
    expect(result.output).toBe(
      [
        'mounts=[{"path":"/","source":"command","versioned":true}]',
        "setup=bun",
        "install_command=bun install --frozen-lockfile",
        "build_command=bun run build",
        "dist_dir=dist",
        "site_title=",
        "docs_dir=docs",
        "link_rot_label=",
        "",
      ].join("\n"),
    );
  });

  test("a missing or invalid files.yml, or an unknown module, fails as a workflow error naming the file", () => {
    const missing = join(temp.dir("plan-files-missing-"), "files.yml");
    const noFile = run(
      { ".repo-platform.yml": "modules: [bun]\n" },
      { PRIVATE: "false", FILES_CONFIG: missing },
    );
    expect(noFile.exitCode).toBe(1);
    expect(noFile.stdout).toContain(`::error::${missing}: cannot read the file`);
    expect(noFile.output).toBe("");
    const invalid = join(temp.dir("plan-files-invalid-"), "files.yml");
    writeFileSync(invalid, "placeholders: []\nfiles: []\nmodules: [bun]\n");
    const badBlock = run(
      { ".repo-platform.yml": "modules: [bun]\n" },
      { PRIVATE: "false", FILES_CONFIG: invalid },
    );
    expect(badBlock.exitCode).toBe(1);
    expect(badBlock.stdout).toContain(`::error::${invalid}: modules: `);
    expect(badBlock.output).toBe("");
    const unknown = run({ ".repo-platform.yml": "modules: [bun, agents]\n" }, { PRIVATE: "false" });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stdout).toContain(
      '::error::.repo-platform.yml: module "agents" is not a module this template offers',
    );
    expect(unknown.output).toBe("");
  });

  test("a missing registration, an invalid one, or an unknown mode fails as a workflow error", () => {
    const missing = run({}, { PRIVATE: "false" });
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain("::error::.repo-platform.yml: missing");
    expect(missing.output).toBe("");
    const invalid = run(
      { ".repo-platform.yml": "modules: [bun]\nnope: 1\n" },
      { PRIVATE: "false" },
    );
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stdout).toContain(
      '::error::.repo-platform.yml: (top level): Unrecognized key: "nope"',
    );
    const mode = run({ ".repo-platform.yml": "modules: []\n" }, { MODE: "release" });
    expect(mode.exitCode).toBe(1);
    expect(mode.stdout).toContain("::error::MODE must be one of default, pages; got 'release'");
  });

  test("a multi-line build command rides the delimited output form", () => {
    const result = run(
      {
        ".repo-platform.yml": "modules: [bun, pages]\n",
        ".github/.copier-answers.yml": `${ANSWERS}pages_setup: bun\npages_build_command: |-\n  bun run generate\n  bun run build\n`,
      },
      { MODE: "pages" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(
      /\nbuild_command<<(ghadelimiter_[0-9a-f]{32})\nbun run generate\nbun run build\n\1\ndist_dir=dist\n/,
    );
  });

  test("a caller-configured deploy publishes the caller's inputs and reads no registration", () => {
    const caller = {
      MODE: "pages",
      CALLER_MOUNTS: '[{"path": "/", "source": "vitepress", "versioned": true}]',
      CALLER_SETUP: "none",
      CALLER_SITE_TITLE: "repo-platform",
      CALLER_DOCS_DIR: "docs",
      CALLER_DIST_DIR: "dist",
      CALLER_LINK_ROT_LABEL: "docs-link-rot",
    };
    const result = run({}, caller);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(
      [
        `mounts=${caller.CALLER_MOUNTS}`,
        "setup=none",
        "install_command=",
        "build_command=",
        "dist_dir=dist",
        "site_title=repo-platform",
        "docs_dir=docs",
        "link_rot_label=docs-link-rot",
        "",
      ].join("\n"),
    );
    const invalid = run({}, { ...caller, CALLER_SETUP: "bun," });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stdout).toContain("::error::setup input: invalid setup value 'bun,'");
  });

  test("every default comes from files.yml: other defaults there change the outputs, a missing one fails", () => {
    const real = readFileSync(FILES_CONFIG, "utf-8");
    const edits: [string, string][] = [
      ["skills_dir: {default: skills}", "skills_dir: {default: agents}"],
      ["    dist: dist\n", "    dist: site\n"],
      ["    path: docs\n", "    path: manual\n"],
    ];
    let other = real;
    for (const [from, to] of edits) {
      expect(other).toContain(from);
      other = other.replace(from, to);
    }
    const dir = temp.dir("plan-files-other-");
    const otherPath = join(dir, "files.yml");
    writeFileSync(otherPath, other);
    const ci = run(
      { ".repo-platform.yml": "modules: [skills, docs-site]\n" },
      { PRIVATE: "false", FILES_CONFIG: otherPath },
    );
    expect(ci.exitCode).toBe(0);
    expect(ci.output).toBe(
      [
        'modules=["docs-site","skills"]',
        "private=false",
        "skills-dir=agents",
        "codeql-languages=[]",
        "tracking-labels=docs-link-rot",
        "",
      ].join("\n"),
    );
    const pages = run(
      { ".repo-platform.yml": "modules: [bun, pages, docs-site]\npages: { setup: bun }\n" },
      { MODE: "pages", FILES_CONFIG: otherPath },
    );
    expect(pages.exitCode).toBe(0);
    expect(pages.output).toBe(
      [
        'mounts=[{"path":"/","source":"command","versioned":false},{"path":"/manual/","source":"vitepress","versioned":true}]',
        "setup=bun",
        "install_command=bun install --frozen-lockfile",
        "build_command=bun run build",
        "dist_dir=site",
        "site_title=",
        "docs_dir=docs",
        "link_rot_label=docs-link-rot",
        "",
      ].join("\n"),
    );
    const missingPath = join(dir, "missing-dist.yml");
    writeFileSync(missingPath, real.replace("    dist: dist\n", ""));
    const missing = run(
      { ".repo-platform.yml": "modules: [skills]\n" },
      { PRIVATE: "false", FILES_CONFIG: missingPath },
    );
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain(`::error::${missingPath}: modules.pages.dist: missing`);
    expect(missing.output).toBe("");
  });

  test("the answers file is optional: a v2 registration plans alone", () => {
    const result = run(
      { ".repo-platform.yml": "modules: [uv, skills]\nskills: { dir: agents }\n" },
      { PRIVATE: "true" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("skills-dir=agents\ncodeql-languages=[]\n");
  });
});
