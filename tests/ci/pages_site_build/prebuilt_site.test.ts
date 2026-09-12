// The layout rows a deploy takes from the hook's dist and docs/ (docs/site.md,
// "Layout"), driven through build.ts the way the action runs it, plus the
// outputs the workflow gates on.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureGit } from "../../shared/fixture_git.ts";
import { tempDirs } from "../../shared/temp_dir.ts";
import {
  buildSite,
  commitAll,
  describeRun,
  initRepo,
  isFile,
  readSite,
  runnerTemp,
  siteConfig,
  TEST_TIMEOUT_MS,
  versionLabels,
} from "./fixtures.ts";

const temp = tempDirs();

const REPO = "fixture-owner/site-repo";

/** The hook's dist: one page linking into the docs mount relatively, so
 *  the link resolves under a project base and a custom domain alike; no
 *  index at all when `index` is null. */
function website(repo: string, index: { marker: string; docsPath: string } | null): void {
  mkdirSync(join(repo, "dist", "assets"), { recursive: true });
  writeFileSync(join(repo, "dist", "assets", "app.js"), "console.log(1)\n");
  if (index !== null) {
    writeFileSync(
      join(repo, "dist", "index.html"),
      `<html><body>${index.marker} <a href="${index.docsPath}/">docs</a></body></html>\n`,
    );
  }
}

function docs(repo: string): void {
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "README.md"), "# Site docs\n\nThe docs landing page.\n");
}

function outputs(stdout: string): Record<string, string> {
  return Object.fromEntries(
    [...stdout.matchAll(/^\(output\) ([a-z-]+)=(.*)$/gm)].map((match) => [match[1], match[2]]),
  );
}

describe("the website and the docs together", () => {
  test(
    "the website at the root, the docs versioned under the docs path, versions.json only there, CNAME with the domain",
    () => {
      const workspace = temp.dir("pages-site-both-");
      website(workspace, { marker: "WEBSITE-ROOT", docsPath: "manual" });
      docs(workspace);
      initRepo(workspace);
      commitAll(workspace, "site and docs");
      fixtureGit(workspace, ["tag", "v1.0.0"]);
      const runner = runnerTemp(temp);
      const result = buildSite(workspace, REPO, runner, {
        SITE_DIR: "dist",
        CUSTOM_DOMAIN: "docs.example.com",
        CONFIG: siteConfig({ site_title: "Site Docs", docs_path: "manual", link_rot_label: "rot" }),
      });
      expect(result.exitCode, describeRun(result)).toBe(0);
      const site = runner.site;
      expect(readSite(site, "index.html")).toContain("WEBSITE-ROOT");
      expect(isFile(site, "assets/app.js")).toBe(true);
      for (const rel of [
        "manual/index.html",
        "manual/latest/index.html",
        "manual/v1.0.0/index.html",
      ]) {
        expect([rel, readSite(site, rel)]).toEqual([
          rel,
          expect.stringContaining("The docs landing page."),
        ]);
      }
      // The docs are built at the domain's root base, under the docs path.
      expect(readSite(site, "manual/latest/index.html")).toContain('href="/manual/latest/');
      expect(versionLabels(join(site, "manual"))).toEqual(["latest", "v1.0.0"]);
      expect(existsSync(join(site, "versions.json"))).toBe(false);
      expect(readSite(site, "CNAME")).toBe("docs.example.com\n");
      expect(outputs(result.stdout)).toEqual({
        "publish": "true",
        "site-dir": site,
        "link-rot-label": "rot",
        "site-title": "Site Docs",
      });
      expect(result.stdout).toMatch(
        /internal links resolve \(\d+ links judged across \d+ current pages\)/,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the website alone: one copy at the root, no version layout, the title falling back to the repository name",
    () => {
      const workspace = temp.dir("pages-site-website-");
      website(workspace, null);
      writeFileSync(
        join(workspace, "dist", "index.html"),
        "<html><body>WEBSITE-ALONE</body></html>\n",
      );
      initRepo(workspace);
      commitAll(workspace, "site only");
      const runner = runnerTemp(temp);
      const result = buildSite(workspace, REPO, runner, { SITE_DIR: "dist" });
      expect(result.exitCode, describeRun(result)).toBe(0);
      expect(readSite(runner.site, "index.html")).toContain("WEBSITE-ALONE");
      expect(existsSync(join(runner.site, "versions.json"))).toBe(false);
      expect(existsSync(join(runner.site, "latest"))).toBe(false);
      expect(existsSync(join(runner.site, "CNAME"))).toBe(false);
      expect(outputs(result.stdout)).toEqual({
        "publish": "true",
        "site-dir": runner.site,
        "link-rot-label": "",
        "site-title": "site-repo",
      });
    },
    TEST_TIMEOUT_MS,
  );
});

describe("nothing to publish and a refused dist", () => {
  test(
    "neither a hook directory nor docs/: green, a notice, publish false, no site directory",
    () => {
      const workspace = temp.dir("pages-site-nothing-");
      writeFileSync(join(workspace, "README.md"), "# Bare\n");
      initRepo(workspace);
      commitAll(workspace, "no site");
      const runner = runnerTemp(temp);
      const result = buildSite(workspace, REPO, runner, {});
      expect(result.exitCode, describeRun(result)).toBe(0);
      expect(result.stdout).toContain(
        "::notice::nothing to publish: the site-build hook named no directory and the repository has no docs/",
      );
      expect(outputs(result.stdout)).toEqual({
        "publish": "false",
        "site-dir": "",
        "link-rot-label": "",
        "site-title": "site-repo",
      });
      expect(existsSync(runner.site)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a docs/ whose landing is index.md alone is refused before any build, naming docs/README.md",
    () => {
      const workspace = temp.dir("pages-site-landing-");
      mkdirSync(join(workspace, "docs"), { recursive: true });
      writeFileSync(join(workspace, "docs", "index.md"), "# Home\n");
      initRepo(workspace);
      commitAll(workspace, "index.md landing");
      const result = buildSite(workspace, REPO, runnerTemp(temp), { CHECK: "true" });
      expect(result.exitCode, describeRun(result)).toBe(1);
      expect(result.stderr).toContain(
        "::error::docs/README.md does not exist - it is the docs landing page; create it",
      );
      expect(result.stdout).not.toContain("vitepress");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a dist without index.html is refused before any docs tier builds",
    () => {
      const workspace = temp.dir("pages-site-refused-");
      website(workspace, null);
      docs(workspace);
      initRepo(workspace);
      commitAll(workspace, "site without an index");
      const result = buildSite(workspace, REPO, runnerTemp(temp), { SITE_DIR: "dist" });
      expect(result.exitCode, describeRun(result)).toBe(1);
      expect(result.stderr).toContain(
        "::error::the site-build hook's dist 'dist' produced no index.html, so its own URL would 404",
      );
      expect(result.stdout).not.toContain("building docs tier");
      expect(outputs(result.stdout)).toEqual({});
    },
    TEST_TIMEOUT_MS,
  );
});
