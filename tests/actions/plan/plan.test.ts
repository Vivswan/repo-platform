// Judged on the REAL module data: the checkout's files.yml, the one the delivery commit carries.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  type SitePlan,
  selectModules,
  weekly,
} from "../../../actions/plan/plan.ts";
import { parseRegistration, type Registration } from "../../../actions/plan/registration.ts";
import { declaredLabelTuple, reservedLabelNames } from "../../../actions/plan/reserved_labels.ts";
import { loadAction } from "../../shared/action_step.ts";
import { boundedSpawnSync } from "../../shared/bounded_spawn.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const REPO_ROOT = join(import.meta.dir, "../../..");
const FILES_CONFIG = join(REPO_ROOT, "files.yml");
const FILES_TREE = join(REPO_ROOT, "files");

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

const RESERVED = reservedLabelNames(FILES_DATA.layers, FILES_TREE);
const SECURITY = declaredLabelTuple(FILES_DATA.layers, FILES_TREE, "security-nightly");

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
    mirrors: FILES_DATA.mirrors,
    reservedLabels: RESERVED,
    securityLabel: SECURITY,
    private: isPrivate,
  };
}

const problemsOf = (run: () => unknown): string[] => {
  try {
    run();
  } catch (error) {
    if (error instanceof PlanError) return error.problems;
    throw error;
  }
  return [];
};

describe("loadModuleData", () => {
  // A default no module declares, or two declare, is a broken delivery commit: no repository plans until it is fixed,
  // and a plan that picked one declarer would deploy the wrong docs under a green run. Every missing default is named
  // at once, under the label the caller passed.
  test.each<[reason: string, text: string, error: string]>([
    [
      "no module declares the docs path",
      MINIMAL_FILES.replace("{ path: docs }", "{}"),
      "modules: no module declares path - the plan reads it as the default",
    ],
    [
      "the docs module carries every other key but the path",
      MINIMAL_FILES.replace("{ path: docs }", "{ tracking_label: { key: site, default: rot } }"),
      "modules: no module declares path - the plan reads it as the default",
    ],
    [
      "two modules declare the docs path",
      `${MINIMAL_FILES}  manual: { path: guide }\n`,
      "modules: path is declared by site, manual - exactly one module declares it",
    ],
    ["a YAML parse error", "a: [\n", "YAML parse error: "],
  ])("fails closed, naming the file, when %s", (_reason, text, error) => {
    expect(loadModuleData(MINIMAL_FILES).defaults).toEqual(FILES_DATA.defaults);
    expect(() => loadModuleData(text, "/build/files.yml")).toThrow(PlanError);
    const problems = problemsOf(() => loadModuleData(text, "/build/files.yml"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith(`/build/files.yml: ${error}`);
    const bare = "placeholders: []\nfiles: []\nmodules: {}\n";
    expect(problemsOf(() => loadModuleData(bare))).toEqual(
      Object.values(REQUIRED_DEFAULTS).map(
        (key) => `files.yml: modules: no module declares ${key} - the plan reads it as the default`,
      ),
    );
  });
});

describe("planCi", () => {
  const MONDAY = new Date("2026-09-07T04:03:00Z");
  const THURSDAY = new Date("2026-09-10T04:03:00Z");
  const SECURITY_ROWS = {
    "security-label": "security-nightly",
    "security-label-color": "1d76db",
    "security-label-description": "Automated nightly security scan findings",
  };

  // The output names are fleet-ci's `needs.plan.outputs` contract; the module order is files.yml's whatever the
  // registration's, the tracking labels follow it with the registration's spellings winning per key, and the fleet
  // security label rides last on every repository, an empty one included.
  test.each<{ reason: string; text: string; now: Date; outputs: Record<string, string> }>([
    {
      reason: "a shuffled selection with two registration labels",
      text: "modules: [nightly, uv, bun, fuzzer, site, release-please]\nlabels: { nightly: nightly-red, fuzzer: 'fuzz: nightly' }\n",
      now: MONDAY,
      outputs: {
        "modules": '["bun","uv","site","release-please","fuzzer","nightly"]',
        "private": "false",
        "codeql-languages": '["javascript-typescript","python"]',
        "tracking-labels": "docs-link-rot,fuzz: nightly,nightly-red,security-nightly",
        ...SECURITY_ROWS,
        "weekly": "true",
      },
    },
    {
      reason: "one label overridden, the other stream on its own default",
      text: "modules: [nightly, fuzzer]\nlabels: { fuzzer: 'fuzz: nightly' }\n",
      now: THURSDAY,
      outputs: {
        "modules": '["fuzzer","nightly"]',
        "private": "false",
        "codeql-languages": "[]",
        "tracking-labels": "fuzz: nightly,nightly-failure,security-nightly",
        ...SECURITY_ROWS,
        "weekly": "false",
      },
    },
    {
      reason: "an empty selection",
      text: "modules: []",
      now: THURSDAY,
      outputs: {
        "modules": "[]",
        "private": "false",
        "codeql-languages": "[]",
        "tracking-labels": "security-nightly",
        ...SECURITY_ROWS,
        "weekly": "false",
      },
    },
  ])(
    "canonical order, CodeQL per toolchain, tracking labels per stream plus the fleet security label: $reason",
    ({ text, now, outputs }) => {
      const plan = planCi(input(text), now);
      expect(plan).toEqual({
        modules: JSON.parse(outputs.modules),
        private: false,
        codeqlLanguages: JSON.parse(outputs["codeql-languages"]),
        trackingLabels: outputs["tracking-labels"].split(","),
        securityLabel: {
          name: "security-nightly",
          color: "1d76db",
          description: "Automated nightly security scan findings",
        },
        weekly: outputs.weekly === "true",
      });
      expect(outputsOf(plan)).toEqual(outputs);
    },
  );

  // The runner's clock is UTC, where getDay and getUTCDay agree; a developer machine is not, so the zone is pinned
  // away from UTC for the case.
  test("weekly is the Monday of the UTC calendar, whatever the hour or the process's zone", () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(new Date("2026-09-07T04:03:00Z").getDay()).toBe(0);
      expect(
        [MONDAY, new Date("2026-09-07T23:59:59Z"), new Date("2026-09-08T00:00:00Z"), THURSDAY].map(
          weekly,
        ),
      ).toEqual([true, true, false, false]);
      expect(planCi(input("modules: []"), THURSDAY).weekly).toBe(false);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  // Personal-account code scanning is public-only; a language two toolchains share reaches the matrix once, and a
  // toolchain's several languages each reach it.
  test("CodeQL is off for a private repository and where no module analyzes; languages are one list, deduplicated", () => {
    expect(planCi(input("modules: [bun, uv]", true)).codeqlLanguages).toEqual([]);
    expect(planCi(input("modules: [rust, site]")).codeqlLanguages).toEqual([]);
    expect(codeqlLanguages(selectModules(input("modules: [deno, bun]")), false)).toEqual([
      "javascript-typescript",
    ]);
    const twoLanguages = loadModuleData(
      `${MINIMAL_FILES}  poly: { codeql_languages: [python, go] }\n  uv: { codeql_languages: [python] }\n`,
    ).modules;
    expect(
      codeqlLanguages(selectModules(input("modules: [poly, uv]", false, twoLanguages)), false),
    ).toEqual(["python", "go"]);
  });

  const BAD_DEFAULT = MODULES.map((m) =>
    m.name === "fuzzer" ? { ...m, tracking_label: { key: "fuzzer", default: "-bad" } } : m,
  );

  // Each refusal is a registration or data file that would otherwise plan a repository nobody meant: a label on no
  // stream labels nothing, a shared label closes the other stream's issues on a green night, a mirror of a file the
  // selection never writes copies nothing, a fleet mirror judged apart from the registration's would let both land at
  // one path. A sound declaration, or an except that hands a fleet mirror's target back to the repository, changes the
  // plan not at all.
  test.each<{ reason: string; text: string; modules?: Module[]; error: string | null }>([
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
        "a tracking label default files.yml spells outside the label grammar, blamed on the data file",
      text: "modules: [fuzzer]",
      modules: BAD_DEFAULT,
      error: "files.yml: the fuzzer tracking label default is not a plain label: -bad",
    },
    {
      reason:
        "a mirror source files.yml does not write for the selection (custom-license drops LICENSE.md)",
      text: "modules: [custom-license]\nmirrors:\n  - {source: LICENSE.md, targets: [skills/*/LICENSE.md]}\n",
      error:
        ".repo-platform.yml: mirrors: source 'LICENSE.md', target 'skills/*/LICENSE.md': the source is not a managed or split file files.yml writes for this repository",
    },
    {
      reason:
        "a mirror target the fleet's mirror claims (one path, one claimant, both declarations named by their document)",
      text: "modules: [bun]\nmirrors:\n  - {source: LICENSE.md, targets: [CLAUDE.md]}\n",
      error:
        "files.yml: mirrors: source 'AGENTS.md', target 'CLAUDE.md': the target is claimed by more than one source\n" +
        "files.yml: mirrors: source 'AGENTS.md', target 'CLAUDE.md': the target is claimed as a copy and as a symbolic link\n" +
        ".repo-platform.yml: mirrors: source 'LICENSE.md', target 'CLAUDE.md': the target is claimed by more than one source\n" +
        ".repo-platform.yml: mirrors: source 'LICENSE.md', target 'CLAUDE.md': the target is claimed as a copy and as a symbolic link",
    },
    {
      reason: "the fleet's mirror source excepted by the registration",
      text: "modules: [bun]\nexcept: [AGENTS.md]\n",
      error:
        "files.yml: mirrors: source 'AGENTS.md', target 'CLAUDE.md': the source is not a managed or split file files.yml writes for this repository\n" +
        "files.yml: mirrors: source 'AGENTS.md', target '.github/agents.md': the source is not a managed or split file files.yml writes for this repository\n" +
        "files.yml: mirrors: source 'AGENTS.md', target '.github/copilot-instructions.md': the source is not a managed or split file files.yml writes for this repository",
    },
    {
      reason: "a sound mirror declaration",
      text: "modules: [bun]\nmirrors:\n  - {source: LICENSE.md, targets: [skills/*/LICENSE.md, template/LICENSE.md]}\n  - {source: AGENTS.md, targets: [skills/*/AGENTS.md]}\n",
      error: null,
    },
    {
      reason: "an except naming a fleet mirror target",
      text: "modules: [bun]\nexcept: [CLAUDE.md]\n",
      error: null,
    },
  ])("$reason", ({ text, modules, error }) => {
    const plan = () => planCi(input(text, false, modules), THURSDAY);
    if (error === null) {
      expect(plan()).toEqual(planCi(input("modules: [bun]\n"), THURSDAY));
      return;
    }
    expect(plan).toThrow(PlanError);
    expect(plan).toThrow(error);
  });
});

describe("planSite", () => {
  const ROT = {
    name: "docs-link-rot",
    color: "D4A72C",
    description: "Automated docs-site link-rot report",
  };
  const config = (plan: SitePlan) =>
    JSON.stringify({
      site_title: plan.siteTitle,
      docs_path: plan.docs === null ? null : plan.docs.path,
      include: plan.docs === null ? [] : plan.docs.include,
      link_rot_label: plan.linkRot.name,
      link_rot_color: plan.linkRot.color,
      link_rot_description: plan.linkRot.description,
    });

  // SiteConfigJson is the pages-site action's input: the include roots verbatim, the docs path from the registration
  // or files.yml's default, and `site.path: null` the docs-half opt-out that plans the website alone.
  test.each<{ reason: string; text: string; plan: SitePlan }>([
    {
      reason: "the registration carries everything",
      text: [
        "modules: [bun, site, fuzzer]",
        "site:",
        "  path: manual",
        "  include:",
        "    - { path: skills, mount: skills, page: SKILL.md }",
        "    - { path: guides, mount: guides, page: GUIDE.md }",
        "labels: { site: rot }",
      ].join("\n"),
      plan: {
        siteTitle: "Demo Project",
        docs: {
          path: "manual",
          include: [
            { path: "skills", mount: "skills", page: "SKILL.md" },
            { path: "guides", mount: "guides", page: "GUIDE.md" },
          ],
        },
        linkRot: { ...ROT, name: "rot" },
      },
    },
    {
      reason: "a bare selection takes every default",
      text: "modules: [site]",
      plan: { siteTitle: "Demo Project", docs: { path: "docs", include: [] }, linkRot: ROT },
    },
    {
      reason: "site.path: null plans no docs half",
      text: "modules: [site]\nsite: { path: null }",
      plan: { siteTitle: "Demo Project", docs: null, linkRot: ROT },
    },
  ])("$reason", ({ text, plan }) => {
    expect(planSite(input(text))).toEqual(plan);
    expect(outputsOf(planSite(input(text)))).toEqual({ config: config(plan) });
  });

  // The docs module is whichever module declares `path`, under any name; its tuple files the link-rot issue under the
  // registration's label for ITS stream, found by name among the selected streams (a tracking-label module listed ahead
  // of it in files.yml would otherwise hand the docs its label).
  test("the docs module is whichever module declares path: its path is the default and its own stream's label and tuple file the link-rot issue", () => {
    const declared = (data: string) =>
      loadModuleData(
        MINIMAL_FILES.replace(
          "  site: { path: docs }",
          `  fuzzer: { tracking_label: { key: fuzzer, default: fuzz-nightly } }\n  manual: ${data}`,
        ),
      );
    const manual = declared(
      "{ path: guide, tracking_label: { key: manual, default: rot, color: ABCDEF, description: Manual link rot } }",
    );
    const plan = planSite({
      ...input("modules: [manual, fuzzer]\nlabels: { manual: custom-rot }"),
      modules: manual.modules,
      defaults: manual.defaults,
    });
    expect(plan).toEqual({
      siteTitle: "Demo Project",
      docs: { path: "guide", include: [] },
      linkRot: { name: "custom-rot", color: "ABCDEF", description: "Manual link rot" },
    });
    const bare = declared("{ path: guide, tracking_label: { key: manual, default: rot } }");
    expect(() =>
      planSite({ ...input("modules: [manual]"), modules: bare.modules, defaults: bare.defaults }),
    ).toThrow(
      "files.yml: modules.manual.tracking_label needs a color and a description - the link-rot issue is filed under them",
    );
    expect(() => planSite(input("modules: [bun]"))).toThrow(
      ".repo-platform.yml: no selected module declares a docs path - there is no site to deploy",
    );
  });
});

describe("outputLines", () => {
  // GITHUB_OUTPUT's heredoc form is GitHub's; a random delimiter is one no value can be authored to close.
  test("one-line values as name=value; a multi-line value under a delimiter it cannot contain", () => {
    expect(outputLines({ a: "x", b: "" })).toBe("a=x\nb=\n");
    const text = outputLines({ note: "line one\nline two" });
    const match = /^note<<(ghadelimiter_[0-9a-f]{32})\nline one\nline two\n\1\n$/.exec(text);
    expect(match).not.toBeNull();
  });
});

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
        FILES_TREE,
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
  const WEEKLY = `weekly=${new Date().getUTCDay() === 1}`;
  const SITE_CONFIG = (title: string, include: string) =>
    `config={"site_title":"${title}","docs_path":"docs","include":${include},"link_rot_label":"docs-link-rot","link_rot_color":"D4A72C","link_rot_description":"Automated docs-site link-rot report"}\n`;

  // The row names are the outputs fleet-ci's plan step hands its jobs: a renamed or missing row leaves them unselected, green.
  // fleet-ci passes no `mode`, so the default-mode row runs under the manifest's declared default.
  const MODE_DEFAULT = String(loadAction("actions/plan/action.yml").inputs?.mode.default);
  test.each<{ reason: string; registration: string; env: Record<string, string>; output: string }>([
    {
      reason: "default mode, the mode fleet-ci gets by omitting the input",
      registration: `modules: [bun, fuzzer, release-please]\n${PROJECT}`,
      env: { PRIVATE: "false", MODE: MODE_DEFAULT },
      output: [
        'modules=["bun","release-please","fuzzer"]',
        "private=false",
        'codeql-languages=["javascript-typescript"]',
        "tracking-labels=fuzz-nightly,security-nightly",
        "security-label=security-nightly",
        "security-label-color=1d76db",
        "security-label-description=Automated nightly security scan findings",
        WEEKLY,
        "",
      ].join("\n"),
    },
    {
      reason: "a private registration",
      registration: `modules: [uv]\n${PROJECT}`,
      env: { PRIVATE: "true" },
      output: [
        'modules=["uv"]',
        "private=true",
        "codeql-languages=[]",
        "tracking-labels=security-nightly",
        "security-label=security-nightly",
        "security-label-color=1d76db",
        "security-label-description=Automated nightly security scan findings",
        WEEKLY,
        "",
      ].join("\n"),
    },
    {
      reason: "site mode",
      registration:
        "modules: [bun, site]\nproject: { name: Site, slug: site, description: d }\nsite: { include: [{ path: skills, mount: skills, page: SKILL.md }] }\n",
      env: { MODE: "site" },
      output: SITE_CONFIG("Site", '[{"path":"skills","mount":"skills","page":"SKILL.md"}]'),
    },
  ])(
    "$reason writes every row fleet-ci reads, and echoes them",
    ({ registration, env, output }) => {
      const result = run({ ".repo-platform.yml": registration }, env);
      expect([result.exitCode, result.output, result.stdout.trimEnd()]).toEqual([
        0,
        output,
        output.trimEnd(),
      ]);
    },
  );

  const missingFiles = () => join(temp.dir("plan-files-missing-"), "files.yml");
  const invalidFiles = () => {
    const path = join(temp.dir("plan-files-invalid-"), "files.yml");
    writeFileSync(path, "placeholders: []\nfiles: []\nmodules: [bun]\n");
    return path;
  };

  // Every refusal is a workflow error naming the document, and no row is written: fleet-ci's jobs read empty outputs
  // as nothing to do. The reserved roster is derived from the files/ tree at run time (FILES_TREE), so a label the
  // settings layers manage is refused whichever layer declares it; site mode reads the registration through the same
  // parse, so a refused key fails the plan before a deploy could read it as nothing.
  test.each<{
    reason: string;
    files: Record<string, string>;
    env: Record<string, string> | ((path: string) => Record<string, string>);
    path?: () => string;
    error: (path: string) => string;
    /** The text after the expected head is the OS's, the schema library's, or the live module roster of files.yml. */
    detail?: true;
  }>([
    {
      reason: "a tracking label naming a label the settings layers manage",
      files: { ".repo-platform.yml": `modules: [fuzzer]\nlabels: { fuzzer: Bug }\n${PROJECT}` },
      env: { PRIVATE: "false" },
      error: () =>
        '::error::tracking label "Bug" (fuzzer) is a label the platform already manages; a green night would close whatever issues carry it and every settings apply would fight over it\n',
    },
    {
      reason: "a missing files.yml",
      files: { ".repo-platform.yml": `modules: [bun]\n${PROJECT}` },
      path: missingFiles,
      env: (path) => ({ PRIVATE: "false", FILES_CONFIG: path }),
      error: (path) => `::error::${path}: cannot read the file`,
      detail: true,
    },
    {
      reason: "an invalid files.yml",
      files: { ".repo-platform.yml": `modules: [bun]\n${PROJECT}` },
      path: invalidFiles,
      env: (path) => ({ PRIVATE: "false", FILES_CONFIG: path }),
      error: (path) => `::error::${path}: modules: `,
      detail: true,
    },
    {
      reason: "an unknown module",
      files: { ".repo-platform.yml": `modules: [bun, agents]\n${PROJECT}` },
      env: { PRIVATE: "false" },
      error: () =>
        '::error::.repo-platform.yml: module "agents" is not a module files.yml offers (known: ',
      detail: true,
    },
    {
      reason: "an impossible mirror declaration, one error per target",
      files: {
        ".repo-platform.yml": `modules: [bun]\n${PROJECT}mirrors:\n  - {source: LICENSE.md, targets: [copies/a, copies/a/b, skills/*/LICENSE.md]}\n`,
      },
      env: { PRIVATE: "false" },
      error: () =>
        "::error::.repo-platform.yml: mirrors: source 'LICENSE.md', target 'copies/a': the target is a path prefix of another target 'copies/a/b'\n" +
        "::error::.repo-platform.yml: mirrors: source 'LICENSE.md', target 'copies/a/b': the target sits under another target 'copies/a'\n",
    },
    {
      reason: "a missing registration",
      files: {},
      env: { PRIVATE: "false" },
      error: () =>
        "::error::.repo-platform.yml: missing - every managed repository registers here\n",
    },
    {
      reason: "an invalid registration",
      files: { ".repo-platform.yml": `modules: [bun]\nnope: 1\n${PROJECT}` },
      env: { PRIVATE: "false" },
      error: () => '::error::.repo-platform.yml: (top level): Unrecognized key: "nope"\n',
    },
    {
      reason: "an unknown mode",
      files: { ".repo-platform.yml": `modules: []\n${PROJECT}` },
      env: { MODE: "pages" },
      error: () => "::error::MODE must be one of default, site; got 'pages'\n",
    },
    ...([{ PRIVATE: "false" }, { MODE: "site" }] as Record<string, string>[]).map((env) => ({
      reason: `an unknown registration key under ${JSON.stringify(env)}`,
      files: {
        ".repo-platform.yml": `modules: [site]\npages: { build: bun run build }\n${PROJECT}`,
      },
      env,
      error: () => '::error::.repo-platform.yml: (top level): Unrecognized key: "pages"\n',
    })),
  ])(
    "$reason fails as a workflow error and writes no row",
    ({ files, env, path, error, detail }) => {
      const at = path?.() ?? "";
      const result = run(files, typeof env === "function" ? env(at) : env);
      const expected = error(at);
      const stdout = detail ? result.stdout.slice(0, expected.length) : result.stdout;
      expect([result.exitCode, result.output, stdout]).toEqual([1, "", expected]);
    },
  );

  // The action reads FILES_CONFIG, not a baked constant: another files.yml changes the outputs, and one without the
  // default fails naming that file.
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
    expect([ci.exitCode, ci.output]).toEqual([
      0,
      [
        'modules=["site"]',
        "private=false",
        "codeql-languages=[]",
        "tracking-labels=docs-link-rot,security-nightly",
        "security-label=security-nightly",
        "security-label-color=1d76db",
        "security-label-description=Automated nightly security scan findings",
        WEEKLY,
        "",
      ].join("\n"),
    ]);
    const site = run(
      { ".repo-platform.yml": `modules: [bun, site]\n${PROJECT}` },
      { MODE: "site", FILES_CONFIG: otherPath },
    );
    expect([site.exitCode, site.output]).toEqual([
      0,
      SITE_CONFIG("Demo Project", "[]").replace('"docs_path":"docs"', '"docs_path":"manual"'),
    ]);
    const missingPath = join(dir, "missing-path.yml");
    writeFileSync(missingPath, real.replace("    path: docs\n", ""));
    const missing = run(
      { ".repo-platform.yml": `modules: [bun]\n${PROJECT}` },
      { PRIVATE: "false", FILES_CONFIG: missingPath },
    );
    expect([missing.exitCode, missing.output]).toEqual([1, ""]);
    expect(missing.stdout).toContain(
      `::error::${missingPath}: modules: no module declares path - the plan reads it as the default`,
    );
  });
});
