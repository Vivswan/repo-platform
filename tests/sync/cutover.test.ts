// The cutover derives a v2 registration from a v1 file and its recorded
// answers: the project block always, each module value only where it
// differs from the module defaults in files.yml, unknown modules dropped
// and noted, mirrors carried; a repository already on v2 or without an
// answers file is left alone, and an invalid derivation is refused.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ANSWERS_FILE,
  cutover,
  deriveRegistration,
} from "../../.github/scripts/sync/writer/cutover.ts";
import { parseFilesConfig } from "../../.github/scripts/sync/writer/files_config.ts";
import { parseRegistration } from "../../actions/plan/registration.ts";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const FIXTURES = join(import.meta.dir, "fixtures/cutover");
const REPOSITORY = { owner: "Vivswan", name: "demo" };

/** The module data a files.yml carries for the modules the fixture selects,
 *  parsed by the writer's own loader so the fixture tracks its shape. */
const CONFIG_YAML = `
placeholders: [skills_dir, fuzzer_label, docs_site_label]
modules:
  bun: { pages: { install: bun install --frozen-lockfile, build: bun run build } }
  uv: { pages: { install: uv sync, build: uv run mkdocs build --site-dir dist } }
  pages: { dist: dist }
  docs-site: { path: docs, tracking_label: { key: docs_site, default: docs-link-rot } }
  fuzzer: { tracking_label: { key: fuzzer, default: fuzz-nightly } }
  skills: { skills_dir: { default: skills } }
files: []
retired:
  - { path: ${ANSWERS_FILE} }
`;
const CONFIG = parseFilesConfig(CONFIG_YAML);

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
  test("keeps the known modules in files.yml order, drops and notes the unknown one", () => {
    const { document, notes } = deriveRegistration(v1(), answers(), CONFIG, REPOSITORY);
    expect(document.modules).toEqual(["bun", "pages", "docs-site", "fuzzer", "skills"]);
    expect(notes).toEqual([
      "cutover: .repo-platform.yml was derived from .github/.copier-answers.yml (modules, project, pages, docs_site, labels, mirrors); review it before merging",
      "cutover: dropped unknown module `custom-license` from .repo-platform.yml (files.yml does not know it)",
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
    // setup "bun" is the selected toolchains, install and build are bun's own.
    expect(document.pages).toEqual({ dist: "public" });
    expect(document.docs_site).toEqual({ path: "guide" });
    expect(document.skills).toBeUndefined();
    expect(document.labels).toEqual({ fuzzer: "fuzz-me" });
    expect(document.mirrors).toEqual([{ source: "LICENSE.md", targets: ["skills/*/LICENSE.md"] }]);
  });

  test("a holder equal to the owner, a default setup, and default labels are omitted", () => {
    const plain = {
      ...answers(),
      copyright_holder: "Vivswan",
      pages_dist_dir: "dist",
      docs_site_path: "docs",
      fuzzer_label: "fuzz-nightly",
    };
    const { document } = deriveRegistration(v1(), plain, CONFIG, REPOSITORY);
    expect(document.project).toEqual({
      name: "Demo Project",
      slug: "demo",
      description: "A demo repository",
    });
    expect(document.pages).toBeUndefined();
    expect(document.docs_site).toBeUndefined();
    expect(document.labels).toBeUndefined();
  });

  test("a non-default setup is written, and the command defaults follow the setup's first toolchain", () => {
    const tuned = {
      ...answers(),
      pages_setup: "uv",
      pages_install_command: "uv sync",
      pages_build_command: "uv run mkdocs build --site-dir dist",
    };
    const { document } = deriveRegistration(
      { modules: ["bun", "uv", "pages"] },
      tuned,
      CONFIG,
      REPOSITORY,
    );
    // The commands are uv's own defaults under a setup naming uv alone, so
    // only the setup and the dist directory are written.
    expect(document.pages).toEqual({ setup: "uv", dist: "public" });
  });

  test("commands that match no toolchain in the resolved setup are written", () => {
    // The setup names bun first (a toolchain the repository does not even
    // select), so uv's commands differ from the defaults and must survive.
    const tuned = {
      ...answers(),
      pages_setup: "bun,uv",
      pages_install_command: "uv sync",
      pages_build_command: "uv run mkdocs build --site-dir dist",
    };
    const { document } = deriveRegistration(
      { modules: ["uv", "pages"] },
      tuned,
      CONFIG,
      REPOSITORY,
    );
    expect(document.pages).toEqual({
      setup: "bun,uv",
      install: "uv sync",
      build: "uv run mkdocs build --site-dir dist",
      dist: "public",
    });
  });

  test("the skills directory default is the one the loader owns, not a module key of its own", () => {
    const lib = parseFilesConfig(CONFIG_YAML.replace("default: skills", "default: lib/skills"));
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
    expect(notes).toHaveLength(2);
    const written = readFileSync(join(target, ".repo-platform.yml"), "utf-8");
    expect(written.startsWith("# Generated once by repo-platform")).toBe(true);
    const parsed = parseRegistration(written);
    expect("registration" in parsed).toBe(true);
    if ("registration" in parsed) {
      expect(parsed.registration.modules).toEqual([
        "bun",
        "pages",
        "docs-site",
        "fuzzer",
        "skills",
      ]);
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
      "modules: [docs-site]\ndocs_site: {include: [{path: guides, mount: guide}]}\n",
    ]) {
      const v2 = seed({ ".repo-platform.yml": v2Text, [ANSWERS_FILE]: answersText });
      expect(cutover(v2, CONFIG, REPOSITORY)).toEqual([]);
      expect(readFileSync(join(v2, ".repo-platform.yml"), "utf-8")).toBe(v2Text);
    }
  });

  test("a malformed mirrors declaration is carried into the schema check and refused there", () => {
    const target = seed({
      ".repo-platform.yml":
        "modules: [bun]\nmirrors: {source: LICENSE.md, targets: [skills/x/LICENSE.md]}\n",
      [ANSWERS_FILE]: answersText,
    });
    expect(() => cutover(target, CONFIG, REPOSITORY)).toThrow("mirrors");
  });

  test("a derivation the registration schema refuses is an error, and the file is untouched", () => {
    const target = seed({
      ".repo-platform.yml": v1Text,
      [ANSWERS_FILE]: answersText.replace("project_slug: demo", "project_slug: Not Kebab"),
    });
    expect(() => cutover(target, CONFIG, REPOSITORY)).toThrow("project.slug");
    expect(readFileSync(join(target, ".repo-platform.yml"), "utf-8")).toBe(v1Text);
  });

  test("a repository name with nothing to slugify fails the schema check naming the field", () => {
    const target = seed({
      ".repo-platform.yml": v1Text,
      [ANSWERS_FILE]: answersText.replace("project_slug: demo\n", ""),
    });
    expect(() => cutover(target, CONFIG, { owner: "Vivswan", name: "___" })).toThrow(
      "project.slug",
    );
    expect(readFileSync(join(target, ".repo-platform.yml"), "utf-8")).toBe(v1Text);
  });
});
