import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  "Read the [reference](reference.md) and the [beta skill](../beta/).",
  "",
  "## Install",
  "",
  "Steps.",
  "",
].join("\n");

/** A README-less skill with frontmatter alone: no h1, so the page is
 *  titled by its name and described by its description. */
const BETA_SKILL = "---\nname: beta\ndescription: Beta does things.\n---\n\nBody of beta.\n";

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
  writeFileSync(join(repo, "docs", "README.md"), DOCS_README.replace(/ and the \[beta.*$/m, ""));
  commitAll(repo, "alpha skill");
  fixtureGit(repo, ["tag", "v0.1.0"]);

  mkdirSync(join(repo, "skills", "beta"));
  writeFileSync(join(repo, "skills", "beta", "SKILL.md"), BETA_SKILL);
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
      expect(alpha).toContain("Source: skills/alpha/SKILL.md");
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
