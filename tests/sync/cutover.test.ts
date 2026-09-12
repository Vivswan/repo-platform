import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ANSWERS_FILE,
  cutover,
  deriveRegistration,
  PAGES_WORKFLOW,
  SITE_BUILD_HOOK,
} from "../../.github/scripts/sync/writer/cutover.ts";
import {
  placeholderDefaults,
  trackingTuples,
  type WriterFilesConfig,
} from "../../.github/scripts/sync/writer/files_config.ts";
import { parseFilesConfig } from "../../actions/plan/files_config.ts";
import { parseRegistration } from "../../actions/plan/registration.ts";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const FIXTURES = join(import.meta.dir, "fixtures/cutover");
const REPOSITORY = { owner: "Vivswan", name: "demo" };

const load = (yaml: string): WriterFilesConfig => {
  const config = parseFilesConfig(yaml);
  return {
    ...config,
    defaults: placeholderDefaults(config).defaults,
    trackingTuples: trackingTuples(config).tuples,
  };
};
const CONFIG_YAML = `
placeholders: [skills_dir, fuzzer_label, site_label]
modules:
  bun: {}
  uv: {}
  site: { path: docs, tracking_label: { key: site, default: docs-link-rot } }
  fuzzer: { tracking_label: { key: fuzzer, default: fuzz-nightly } }
  skills: { skills_dir: { default: skills } }
files: []
retired:
  - { path: ${ANSWERS_FILE} }
`;
const CONFIG = load(CONFIG_YAML);
const DERIVED_NOTE =
  "cutover: .repo-platform.yml was derived from .github/.copier-answers.yml (modules, project, labels, mirrors); review it before merging";
const dropped = (name: string) =>
  `cutover: dropped unknown module \`${name}\` from .repo-platform.yml (files.yml does not know it)`;
const HOOK_NOTE =
  `cutover: the \`pages\` module is the \`site\` module now, and its build is the repo-owned ${SITE_BUILD_HOOK} hook: ` +
  "select `site` and move the recorded pages_setup=`bun`, pages_install_command=`bun install --frozen-lockfile`, pages_build_command=`bun run build`, pages_dist_dir=`public` into the hook before merging";
const DOCS_SELECT_NOTE =
  "cutover: the `docs-site` module is the `site` module now: select `site` before merging";
const DOCS_PATH_NOTE =
  "cutover: the `docs-site` module is the `site` module now: select `site` and set site.path to `guide` (the recorded docs_site_path) before merging";

const answers = () =>
  parseYaml(readFileSync(join(FIXTURES, ".copier-answers.yml"), "utf-8")) as Record<
    string,
    unknown
  >;
const v1 = () =>
  parseYaml(readFileSync(join(FIXTURES, "repo-platform.v1.yml"), "utf-8")) as Record<
    string,
    unknown
  >;

function seed(files: Record<string, string>): string {
  const target = temp.dir("cutover-target-");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(target, rel, ".."), { recursive: true });
    writeFileSync(join(target, rel), content);
  }
  return target;
}

describe("deriveRegistration", () => {
  test("keeps the known modules in files.yml order, drops and notes the unknown ones, and notes the site the old modules built", () => {
    const { document, notes } = deriveRegistration(v1(), answers(), CONFIG, REPOSITORY);
    expect(document.modules).toEqual(["bun", "fuzzer", "skills"]);
    expect(notes).toEqual([
      DERIVED_NOTE,
      dropped("docs-site"),
      dropped("pages"),
      dropped("custom-license"),
      HOOK_NOTE,
      DOCS_PATH_NOTE,
    ]);
  });

  test("writes the project block whole and every other value only where it differs from the default", () => {
    const { document } = deriveRegistration(v1(), answers(), CONFIG, REPOSITORY);
    expect(document.project).toEqual({
      name: "Demo Project",
      slug: "demo",
      description: "A demo repository",
      copyright_holder: "Vivswan Shah (https://github.com/Vivswan)",
    });
    expect(document.skills).toBeUndefined();
    expect(document.labels).toEqual({ fuzzer: "fuzz-me" });
    expect(document.mirrors).toEqual([{ source: "LICENSE.md", targets: ["skills/*/LICENSE.md"] }]);
    // The site answers are notes, never keys: no `pages` or `docs_site` block.
    expect(Object.keys(document)).toEqual(["modules", "project", "labels", "mirrors"]);
  });

  test("a holder equal to the owner, default labels, and the default docs path are omitted", () => {
    const plain = {
      ...answers(),
      copyright_holder: "Vivswan",
      docs_site_path: "docs",
      fuzzer_label: "fuzz-nightly",
    };
    const { document, notes } = deriveRegistration(v1(), plain, CONFIG, REPOSITORY);
    expect(document.project).toEqual({
      name: "Demo Project",
      slug: "demo",
      description: "A demo repository",
    });
    expect(document.labels).toBeUndefined();
    // The select-site notes stay: the build has no default worth keeping quiet about.
    expect(notes.filter((note) => note.includes("`site`"))).toEqual([HOOK_NOTE, DOCS_SELECT_NOTE]);
  });

  // Copier recorded every answer whether or not its module was selected, so
  // the selection decides whether a recorded site answer is a note.
  test.each<{
    reason: string;
    modules: string[];
    answers: Record<string, string>;
    notes: string[];
  }>([
    {
      reason: "pages selected with its build recorded",
      modules: ["bun", "pages"],
      answers: {
        pages_build_command: "uv run mkdocs build --site-dir dist",
        pages_dist_dir: "dist",
      },
      notes: [
        `cutover: the \`pages\` module is the \`site\` module now, and its build is the repo-owned ${SITE_BUILD_HOOK} hook: ` +
          "select `site` and move the recorded pages_build_command=`uv run mkdocs build --site-dir dist`, pages_dist_dir=`dist` into the hook before merging",
      ],
    },
    {
      reason: "pages recorded but not selected (the control)",
      modules: ["bun"],
      answers: { pages_build_command: "bun run build", pages_dist_dir: "dist" },
      notes: [],
    },
    {
      reason: "pages selected with only empty answers recorded",
      modules: ["pages"],
      answers: { pages_install_command: "", pages_build_command: "" },
      notes: [
        `cutover: the \`pages\` module is the \`site\` module now, and its build is the repo-owned ${SITE_BUILD_HOOK} hook: select \`site\` and move its build into the hook before merging`,
      ],
    },
    {
      reason: "docs-site selected with a non-default path",
      modules: ["docs-site"],
      answers: { docs_site_path: "guide" },
      notes: [DOCS_PATH_NOTE],
    },
    {
      reason: "docs-site selected with the default path and label still needs the module selected",
      modules: ["docs-site"],
      answers: { docs_site_path: "docs", docs_site_label: "docs-link-rot" },
      notes: [DOCS_SELECT_NOTE],
    },
    {
      reason:
        "docs-site selected with a custom label, which the site default would silently replace",
      modules: ["docs-site"],
      answers: { docs_site_path: "guide", docs_site_label: "custom-docs-rot" },
      notes: [
        "cutover: the `docs-site` module is the `site` module now: select `site` and set site.path to `guide` (the recorded docs_site_path) and labels.site to `custom-docs-rot` (the recorded docs_site_label) before merging",
      ],
    },
  ])("$reason", (row) => {
    const { notes } = deriveRegistration({ modules: row.modules }, row.answers, CONFIG, REPOSITORY);
    expect(notes.filter((note) => note.includes("`site`"))).toEqual(row.notes);
  });

  test("the skills directory default is the one the loader owns, not a module key of its own", () => {
    const lib = load(CONFIG_YAML.replace("default: skills", "default: lib/skills"));
    const { document } = deriveRegistration({ modules: ["skills"] }, answers(), lib, REPOSITORY);
    expect(document.skills).toEqual({ dir: "skills" });
  });

  test.each([
    ["demo", "demo"],
    ["Demo_Project", "demo-project"],
    ["Demo_Project.v2", "demo-project-v2"],
    ["--Weird__Name--", "weird-name"],
  ])(
    "missing answers fall back to the repository name %s, its kebab-case %s, and an empty description",
    (name, slug) => {
      const { document } = deriveRegistration({ modules: ["bun"] }, {}, CONFIG, {
        owner: "Vivswan",
        name,
      });
      expect(document).toEqual({ modules: ["bun"], project: { name, slug, description: "" } });
    },
  );

  test("a recorded answer of the wrong type is the answers file's error, never a default", () => {
    expect(() =>
      deriveRegistration(
        { modules: ["skills"] },
        { ...answers(), skills_dir: 3 },
        CONFIG,
        REPOSITORY,
      ),
    ).toThrow("skills_dir must be a string");
  });

  test("a v1 file without a modules list is refused", () => {
    expect(() => deriveRegistration({}, answers(), CONFIG, REPOSITORY)).toThrow(
      "no module selection found",
    );
  });
});

describe("cutover", () => {
  const answersText = readFileSync(join(FIXTURES, ".copier-answers.yml"), "utf-8");
  const v1Text = readFileSync(join(FIXTURES, "repo-platform.v1.yml"), "utf-8");

  test("rewrites the v1 registration as a valid v2 document and leaves the answers file to the retirement", () => {
    const target = seed({ ".repo-platform.yml": v1Text, [ANSWERS_FILE]: answersText });
    const notes = cutover(target, CONFIG, REPOSITORY);
    expect(notes).toEqual([
      DERIVED_NOTE,
      dropped("docs-site"),
      dropped("pages"),
      dropped("custom-license"),
      HOOK_NOTE,
      DOCS_PATH_NOTE,
    ]);
    const written = readFileSync(join(target, ".repo-platform.yml"), "utf-8");
    expect(written.split("\n")[0]).toBe(
      "# Written once by repo-platform and repo-owned from then on: the sync reads this file and never rewrites it.",
    );
    const parsed = parseRegistration(written);
    expect("registration" in parsed).toBe(true);
    if ("registration" in parsed) {
      expect(parsed.registration.modules).toEqual(["bun", "fuzzer", "skills"]);
      expect(parsed.registration.project?.slug).toBe("demo");
      expect(parsed.registration.labels).toEqual({ fuzzer: "fuzz-me" });
    }
    expect(existsSync(join(target, ANSWERS_FILE))).toBe(true);
    // Idempotent: the rewritten file carries a project block, so a second
    // run has nothing to do.
    expect(cutover(target, CONFIG, REPOSITORY)).toEqual([]);
    expect(readFileSync(join(target, ".repo-platform.yml"), "utf-8")).toBe(written);
  });

  test("a repository without an answers file, or already on v2, is left alone", () => {
    const noAnswers = seed({ ".repo-platform.yml": v1Text });
    expect(cutover(noAnswers, CONFIG, REPOSITORY)).toEqual([]);
    expect(readFileSync(join(noAnswers, ".repo-platform.yml"), "utf-8")).toBe(v1Text);
    // Any key beyond the old template's modules and mirrors means the new
    // registration, whether or not a project block is among them.
    for (const v2Text of [
      "modules: [bun]\nproject: {name: Demo, slug: demo, description: d}\n",
      "modules: [site]\nlabels: {site: rot}\n",
    ]) {
      const v2 = seed({ ".repo-platform.yml": v2Text, [ANSWERS_FILE]: answersText });
      expect(cutover(v2, CONFIG, REPOSITORY)).toEqual([]);
      expect(readFileSync(join(v2, ".repo-platform.yml"), "utf-8")).toBe(v2Text);
    }
  });

  // The retired deploy's presence marks a website the no-op hook would
  // silently drop; the hold recurs until the workflow is gone or the hook
  // exists, whatever the registration's shape.
  test.each<{
    reason: string;
    files: Record<string, string>;
    link?: [string, string];
    notes: string[];
  }>([
    {
      reason: "a v2 registration with the retired pages.yml and no hook",
      files: {
        ".repo-platform.yml": "modules: [bun, site]\nlabels: {site: rot}\n",
        [PAGES_WORKFLOW]: "name: Pages\n",
      },
      notes: [
        `site cutover: ${PAGES_WORKFLOW} is retired and ${SITE_BUILD_HOOK} is seeded as a no-op; move the former pages build into the hook before merging, or the next main run serves the docs alone (or nothing)`,
      ],
    },
    {
      reason: "the same repository once its hook exists (the control)",
      files: {
        ".repo-platform.yml": "modules: [bun, site]\nlabels: {site: rot}\n",
        [PAGES_WORKFLOW]: "name: Pages\n",
        [SITE_BUILD_HOOK]: "name: Site Build\n",
      },
      notes: [],
    },
    {
      reason: "a hook that is a symlink counts as present, as the starter writer judges it",
      files: { ".repo-platform.yml": "modules: [bun, site]\n", [PAGES_WORKFLOW]: "name: Pages\n" },
      link: [SITE_BUILD_HOOK, "../build/action.yml"],
      notes: [],
    },
    {
      reason: "a v1 registration with the retired pages.yml, ahead of the answers notes",
      files: {
        ".repo-platform.yml": v1Text,
        [ANSWERS_FILE]: answersText,
        [PAGES_WORKFLOW]: "name: Pages\n",
      },
      notes: [
        `site cutover: ${PAGES_WORKFLOW} is retired and ${SITE_BUILD_HOOK} is seeded as a no-op; move the former pages build into the hook before merging, or the next main run serves the docs alone (or nothing)`,
        DERIVED_NOTE,
        dropped("docs-site"),
        dropped("pages"),
        dropped("custom-license"),
        HOOK_NOTE,
        DOCS_PATH_NOTE,
      ],
    },
  ])("$reason", (row) => {
    const target = seed(row.files);
    if (row.link !== undefined) {
      mkdirSync(join(target, row.link[0], ".."), { recursive: true });
      symlinkSync(row.link[1], join(target, row.link[0]));
    }
    expect(cutover(target, CONFIG, REPOSITORY)).toEqual(row.notes);
  });

  test("a malformed mirrors declaration is carried into the schema check and refused there", () => {
    const target = seed({
      ".repo-platform.yml":
        "modules: [bun]\nmirrors: {source: LICENSE.md, targets: [skills/x/LICENSE.md]}\n",
      [ANSWERS_FILE]: answersText,
    });
    expect(() => cutover(target, CONFIG, REPOSITORY)).toThrow("mirrors");
  });

  // The old Copier questions accepted text the registration grammar refuses
  // (a holder with a double quote breaks the quoted scalars the writer
  // substitutes it into), so the refusal comes here, naming the field and
  // the answers file, before any file is written.
  test.each([
    {
      reason: "a slug that is not kebab-case",
      answers: answersText.replace("project_slug: demo", "project_slug: Not Kebab"),
      repository: REPOSITORY,
      error: /is invalid[\s\S]*project\.slug/,
    },
    {
      reason: "a copyright holder with a double quote",
      answers: answersText.replace(/^copyright_holder: .*$/m, "copyright_holder: 'Acme \"Labs\"'"),
      repository: REPOSITORY,
      error:
        /derived from \.github\/\.copier-answers\.yml is invalid[\s\S]*project\.copyright_holder must not contain double quotes/,
    },
    {
      reason: "no recorded slug and a repository name with nothing to slugify",
      answers: answersText.replace("project_slug: demo\n", ""),
      repository: { owner: "Vivswan", name: "___" },
      error: /is invalid[\s\S]*project\.slug/,
    },
  ])("$reason fails the schema check naming the field, and the file is untouched", (row) => {
    const target = seed({ ".repo-platform.yml": v1Text, [ANSWERS_FILE]: row.answers });
    expect(() => cutover(target, CONFIG, row.repository)).toThrow(row.error);
    expect(readFileSync(join(target, ".repo-platform.yml"), "utf-8")).toBe(v1Text);
  });
});
