import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixtureGit } from "../../shared/fixture_git.ts";
import { tempDirs } from "../../shared/temp_dir.ts";
import {
  buildSite,
  commitAll,
  describeRun,
  initRepo,
  isFile,
  readAssets,
  readSite,
  runnerTemp,
  TEST_TIMEOUT_MS,
} from "./fixtures.ts";
import { select, texts } from "./html.ts";

const temp = tempDirs();

const REPO = "fixture-owner/inc-repo";

/** A website at "/" over the docs at "/docs/" with the skills/ root
 *  rendered inside the docs mount. */
const MOUNTS =
  '[{"path": "/", "source": "command", "versioned": false},' +
  ' {"path": "/docs/", "source": "vitepress", "versioned": true,' +
  ' "include": [{"path": "skills", "mount": "skills", "page": "SKILL.md"}]}]';

/** The website's one page links INTO the docs mount, into an include page
 *  among them: the class of link nothing but the assembled-site gate can
 *  judge. `extra` adds a link the fail case breaks. */
function siteScript(extra: string): string {
  // Double-quoted for the shell, so $PAGES_BASE_PATH expands at build time;
  // the other characters the shell reads inside double quotes are escaped.
  const links = [
    '<a href=\\"${PAGES_BASE_PATH}docs/\\">docs</a>',
    '<a href=\\"${PAGES_BASE_PATH}docs/skills/alpha/\\">alpha</a>',
    // Extensionless, as Pages serves it; and a sibling site of the same
    // owner, which is not this artifact's to judge.
    '<a href=\\"${PAGES_BASE_PATH}docs/skills/alpha/reference\\">reference</a>',
    '<a href=\\"https://fixture-owner.github.io/other-repo/\\">sibling</a>',
    extra.replace(/[\\"`]/g, "\\$&"),
  ].join(" ");
  return `mkdir -p dist && echo "<html><body>${links}</body></html>" > dist/index.html`;
}

function packageJson(repo: string, extra = ""): void {
  writeFileSync(
    join(repo, "package.json"),
    `${JSON.stringify({ name: "inc-fixture", scripts: { "build:site": siteScript(extra) } })}\n`,
  );
}

const ALPHA_SKILL = [
  "---",
  "name: alpha",
  "description: The alpha skill.",
  "---",
  "",
  "# Alpha skill",
  "",
  "Read the [reference](reference.md) and the [beta skill](../beta).",
  "",
  "Plugin metadata sits in [plugin.json](.codex-plugin/plugin.json).",
  "",
  "## Install",
  "",
  "Steps.",
  "",
].join("\n");

/** A README-less skill with frontmatter alone: no h1, so the page is
 *  titled by its name and described by its description. */
const BETA_SKILL = "---\nname: beta\ndescription: Beta does things.\n---\n\nBody of beta.\n";

/** A skill whose name says nothing (blank) and no h1: titled by its file
 *  name, in the document title and the sidebar alike. */
const GAMMA_SKILL = "---\nname: '   '\n---\n\nBody of gamma.\n";

const DOCS_README =
  "# Fixture\n\nSee the [skills](skills/), the [alpha skill](skills/alpha/), " +
  "and how to [install it](skills/alpha/#install).\n";

/** History: v0.0.1 predates skills/ and keeps its own docs/skills/README.md
 *  at the mount's name (that tier skips the root with a notice and serves
 *  the docs page there), v0.1.0 carries alpha alone, HEAD adds beta and a
 *  skills landing table. */
function includeFixture(repo: string): void {
  mkdirSync(join(repo, "docs", "skills"), { recursive: true });
  packageJson(repo);
  writeFileSync(join(repo, "docs", "README.md"), "# Fixture\n\nDocs only, so far.\n");
  writeFileSync(join(repo, "docs", "skills", "README.md"), "# Skills, hand-written\n");
  initRepo(repo);
  commitAll(repo, "docs before skills");
  fixtureGit(repo, ["tag", "v0.0.1"]);

  rmSync(join(repo, "docs", "skills"), { recursive: true });
  mkdirSync(join(repo, "skills", "alpha"), { recursive: true });
  writeFileSync(join(repo, "skills", "alpha", "SKILL.md"), ALPHA_SKILL);
  writeFileSync(join(repo, "skills", "alpha", "reference.md"), "# Alpha reference\n\nDetails.\n");
  mkdirSync(join(repo, "skills", "alpha", ".codex-plugin"));
  writeFileSync(join(repo, "skills", "alpha", ".codex-plugin", "plugin.json"), "{}\n");
  writeFileSync(join(repo, "docs", "README.md"), DOCS_README.replace(/ and the \[beta.*$/m, ""));
  commitAll(repo, "alpha skill");
  fixtureGit(repo, ["tag", "v0.1.0"]);

  mkdirSync(join(repo, "skills", "beta"));
  writeFileSync(join(repo, "skills", "beta", "SKILL.md"), BETA_SKILL);
  mkdirSync(join(repo, "skills", "gamma"));
  writeFileSync(join(repo, "skills", "gamma", "SKILL.md"), GAMMA_SKILL);
  writeFileSync(
    join(repo, "skills", "README.md"),
    "# Skills\n\n| Skill | Purpose |\n|---|---|\n| [alpha](alpha/) | Alpha |\n| [beta](beta/) | Beta |\n",
  );
  writeFileSync(join(repo, "docs", "README.md"), DOCS_README);
  commitAll(repo, "beta skill and the skills landing");
}

const ENV = { MOUNTS, BUILD_COMMAND: "bun run build:site", SITE_TITLE: "Inc Docs" };

describe("include roots in the assembled site", () => {
  test(
    "renders skills/ inside the docs mount per tier, titles and sources them from SKILL.md, and passes the cross-mount link gate",
    () => {
      const workspace = temp.dir("pages-site-include-");
      includeFixture(workspace);
      const runner = runnerTemp(temp);
      const result = buildSite(workspace, REPO, runner, ENV);
      expect(result.exitCode, describeRun(result)).toBe(0);
      const site = runner.site;

      // The page file serves at the directory URL in every tier whose tree
      // carries the root; the tag from before skills/ existed skips it.
      expect(isFile(site, "docs/latest/skills/index.html")).toBe(true);
      expect(isFile(site, "docs/latest/skills/alpha/index.html")).toBe(true);
      expect(isFile(site, "docs/latest/skills/alpha/reference.html")).toBe(true);
      expect(isFile(site, "docs/latest/skills/beta/index.html")).toBe(true);
      expect(isFile(site, "docs/latest/skills/alpha/SKILL.html")).toBe(false);
      expect(isFile(site, "docs/skills/alpha/index.html")).toBe(true);
      expect(isFile(site, "docs/v0.1.0/skills/alpha/index.html")).toBe(true);
      expect(existsSync(join(site, "docs/v0.1.0/skills/beta"))).toBe(false);
      // The tag from before the root existed serves its own docs/skills page
      // at the mount's name, and the missing root is a notice, not a collision.
      expect(readSite(site, "docs/v0.0.1/skills/index.html")).toContain("Skills, hand-written");
      expect(existsSync(join(site, "docs/v0.0.1/skills/alpha"))).toBe(false);
      expect(result.stdout).toContain(
        "::notice::docs version v0.0.1 has no skills/: skills/ does not exist at v0.0.1",
      );

      // Identity from the skill's own frontmatter where it has no h1, and
      // the source path and edit link at the real repository path.
      const alpha = readSite(site, "docs/latest/skills/alpha/index.html");
      const beta = readSite(site, "docs/latest/skills/beta/index.html");
      expect(texts(beta, "title")).toEqual(["beta | Inc Docs"]);
      expect(select(beta, 'meta[name="description"]').map((m) => m.attrs.content)).toEqual([
        "Beta does things.",
      ]);
      expect(texts(alpha, "title")).toEqual(["Alpha skill | Inc Docs"]);
      // A blank name says nothing: the file name titles the document, as
      // it titles the sidebar row below.
      const gamma = readSite(site, "docs/latest/skills/gamma/index.html");
      expect(texts(gamma, "title")).toEqual(["SKILL | Inc Docs"]);
      expect(alpha).toContain("Source: skills/alpha/SKILL.md");
      // A file the site never publishes reads on GitHub at the tier's ref;
      // a directory link without its slash is the directory URL.
      const alphaLinks = select(alpha, ".vp-doc a").map((a) => a.attrs.href);
      expect(alphaLinks).toContain(
        "https://github.com/fixture-owner/inc-repo/blob/main/skills/alpha/.codex-plugin/plugin.json",
      );
      expect(alphaLinks).toContain("./../beta/");
      expect(
        select(readSite(site, "docs/v0.1.0/skills/alpha/index.html"), ".vp-doc a").map(
          (a) => a.attrs.href,
        ),
      ).toContain(
        "https://github.com/fixture-owner/inc-repo/blob/v0.1.0/skills/alpha/.codex-plugin/plugin.json",
      );
      expect(
        select(alpha, ".VPDocFooter a.edit-link-button, a.edit-link-button").map(
          (a) => a.attrs.href,
        ),
      ).toEqual(["https://github.com/fixture-owner/inc-repo/edit/main/skills/alpha/SKILL.md"]);
      const docsIndex = readSite(site, "docs/latest/index.html");
      expect(docsIndex).toContain("Source: docs/README.md");
      expect(select(docsIndex, "a.edit-link-button").map((a) => a.attrs.href)).toEqual([
        "https://github.com/fixture-owner/inc-repo/edit/main/docs/README.md",
      ]);
      // A skill page is an article with its outline; the root's README is
      // the section's landing page.
      expect(alpha).not.toContain('class="fleet-facts');
      expect(readSite(site, "docs/latest/skills/index.html")).toContain('class="fleet-facts');

      // The sidebar groups the root under its title-cased mount, and the
      // launcher's page index serves the include pages at their directory
      // URLs (the sidebar carries the same URL, so the index is read alone).
      expect(texts(docsIndex, ".VPSidebar .text")).toEqual([
        "Fixture",
        "Skills",
        "Skills",
        "Alpha",
        "Alpha skill",
        "Alpha reference",
        "Beta",
        "beta",
        "Gamma",
        "SKILL",
      ]);
      const assets = readAssets(site, "docs/latest/assets");
      expect(assets).toContain('"url":"/inc-repo/docs/latest/skills/beta/"');
      expect(assets).not.toContain("skills/beta/SKILL.html");
      expect(result.stdout).toMatch(
        /internal links resolve \(\d+ links judged across \d+ current pages\)/,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "fails the assembly on a website link into a missing docs page and on a docs link to a missing anchor, naming both",
    () => {
      const workspace = temp.dir("pages-site-include-broken-");
      includeFixture(workspace);
      packageJson(workspace, '<a href="${PAGES_BASE_PATH}docs/skills/missing/">gone</a>');
      const readme = join(workspace, "docs", "README.md");
      writeFileSync(
        readme,
        `${readFileSync(readme, "utf-8")}\nAnd [nothing](skills/alpha/#nope).\n`,
      );
      commitAll(workspace, "break two links");
      const result = buildSite(workspace, REPO, runnerTemp(temp), ENV);
      expect(result.exitCode, describeRun(result)).not.toBe(0);
      expect(result.stdout).toContain(
        "  /inc-repo/index.html -> /inc-repo/docs/skills/missing/ (status 404)",
      );
      expect(result.stdout).toContain(
        "  /inc-repo/docs/latest/index.html -> /inc-repo/docs/latest/skills/alpha/#nope (no element with id 'nope' on that page)",
      );
      expect(result.stderr).toContain("::error::2 broken internal links in the current content");
    },
    TEST_TIMEOUT_MS,
  );
});

/** The docs PR check's single build over a HEAD tree with the skills
 *  root, before `mutate` breaks the layout. */
function refusalFixture(repo: string, mutate: (repo: string) => void): void {
  mkdirSync(join(repo, "docs"), { recursive: true });
  mkdirSync(join(repo, "skills", "alpha"), { recursive: true });
  writeFileSync(join(repo, "docs", "README.md"), "# Fixture\n");
  writeFileSync(join(repo, "skills", "alpha", "SKILL.md"), ALPHA_SKILL);
  mutate(repo);
}

const CHECK_ENV = {
  CHECK: "true",
  MOUNTS:
    '[{"path": "/", "source": "vitepress", "versioned": true,' +
    ' "include": [{"path": "skills", "mount": "skills", "page": "SKILL.md"}]}]',
};

describe("include root staging refusals", () => {
  test.each<[string, (repo: string) => void, string]>([
    [
      "HEAD without the root",
      (repo) => rmSync(join(repo, "skills"), { recursive: true }),
      "skills/ does not exist in the repository - the docs site includes it at skills/; create it or drop the include",
    ],
    [
      "the root a file",
      (repo) => {
        rmSync(join(repo, "skills"), { recursive: true });
        writeFileSync(join(repo, "skills"), "not a directory\n");
      },
      "the include root 'skills' is a file, not a directory, at HEAD",
    ],
    [
      "the docs tree already carrying the mount",
      (repo) => {
        mkdirSync(join(repo, "docs", "skills"));
        writeFileSync(join(repo, "docs", "skills", "README.md"), "# Hand-written\n");
      },
      "the include root 'skills' mounts at 'skills/', which the docs tree (docs/, or a root mounted above it) already carries at HEAD - two sources would claim one URL; mount the root under another name",
    ],
    [
      "a child carrying both the page and index.md",
      (repo) => writeFileSync(join(repo, "skills", "alpha", "index.md"), "# Also alpha\n"),
      "skills/alpha/ carries both SKILL.md and index.md - both would serve at skills/alpha/; remove one",
    ],
  ])(
    "refuses %s before any build",
    (_, mutate, message) => {
      const workspace = temp.dir("pages-site-include-refusal-");
      refusalFixture(workspace, mutate);
      const result = buildSite(workspace, REPO, runnerTemp(temp), CHECK_ENV);
      expect(result.exitCode, describeRun(result)).not.toBe(0);
      expect(result.stderr).toContain(`::error::${message}`);
      expect(result.stdout).not.toContain("vitepress");
    },
    TEST_TIMEOUT_MS,
  );
});

/** The agents/ root mounted INSIDE the skills root's mount, listed child
 *  first: staging order is the mount's depth, never the list's. */
const NESTED_CHECK_ENV = {
  CHECK: "true",
  MOUNTS:
    '[{"path": "/", "source": "vitepress", "versioned": true, "include": [' +
    '{"path": "agents", "mount": "skills/agents", "page": "AGENT.md"},' +
    ' {"path": "skills", "mount": "skills", "page": "SKILL.md"}]}]',
};

/** The skill links the agent in repository space; the agent links back. */
function nestedFixture(repo: string): void {
  refusalFixture(repo, () => {});
  writeFileSync(
    join(repo, "skills", "alpha", "SKILL.md"),
    `${ALPHA_SKILL.replace(/ and the \[beta.*$/m, ".")}\nSee the [one agent](../../agents/one/AGENT.md).\n`,
  );
  writeFileSync(join(repo, "skills", "alpha", "reference.md"), "# Alpha reference\n");
  mkdirSync(join(repo, "agents", "one"), { recursive: true });
  writeFileSync(
    join(repo, "agents", "one", "AGENT.md"),
    "---\nname: one\n---\n\nUses the [alpha skill](../../skills/alpha/SKILL.md#install).\n",
  );
  initRepo(repo);
  commitAll(repo, "nested roots");
}

describe("nested include mounts", () => {
  test(
    "a root mounted inside another's mount stages whichever is listed first, and links cross between them",
    () => {
      const workspace = temp.dir("pages-site-include-nested-");
      nestedFixture(workspace);
      const runner = runnerTemp(temp);
      const result = buildSite(workspace, REPO, runner, NESTED_CHECK_ENV);
      expect(result.exitCode, describeRun(result)).toBe(0);
      expect(result.stdout).toMatch(
        /docs build check passed \(\d+ links judged across \d+ pages\)/,
      );
      // Both roots rendered, the child inside the parent's mount, and each
      // page's link to the other is an on-site route (a missing root would
      // have sent it to GitHub, which the gate never judges).
      const dist = join(dirname(runner.site), "build-0", ".vitepress", "dist");
      const skill = readSite(dist, "skills/alpha/index.html");
      const agent = readSite(dist, "skills/agents/one/index.html");
      expect(select(skill, ".vp-doc a").map((a) => a.attrs.href)).toContain("./../agents/one/");
      expect(select(agent, ".vp-doc a").map((a) => a.attrs.href)).toContain(
        "./../../alpha/#install",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "refuses the child mount when the parent's own source carries that directory",
    () => {
      const workspace = temp.dir("pages-site-include-nested-collision-");
      nestedFixture(workspace);
      mkdirSync(join(workspace, "skills", "agents"));
      writeFileSync(join(workspace, "skills", "agents", "README.md"), "# Hand-written agents\n");
      const result = buildSite(workspace, REPO, runnerTemp(temp), NESTED_CHECK_ENV);
      expect(result.exitCode, describeRun(result)).not.toBe(0);
      expect(result.stderr).toContain(
        "::error::the include root 'agents' mounts at 'skills/agents/', which the docs tree (docs/, or a root mounted above it) already carries at HEAD - two sources would claim one URL; mount the root under another name",
      );
      expect(result.stdout).not.toContain("vitepress");
    },
    TEST_TIMEOUT_MS,
  );
});
