// docs/site.md's Layout rows as the artifact tree a deploy lands from the hook's dist and docs/,
// with the outputs reusable-site.yml gates on: siteLayout's unit table pins the rows as values,
// step_output_gates pins the read of `publish`, this pins its write.

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureGit } from "../../shared/fixture_git.ts";
import { tempDirs } from "../../shared/temp_dir.ts";
import {
  buildSite,
  commitAll,
  describeRun,
  expectRefusedBeforeBuild,
  initRepo,
  isFile,
  outputs,
  present,
  readSite,
  runnerTemp,
  SITE_TITLE,
  siteConfig,
  TEST_TIMEOUT_MS,
  versionLabels,
} from "./fixtures.ts";

const temp = tempDirs();

const REPO = "fixture-owner/site-repo";

/** The hook's dist: one page linking into the docs mount relatively, so
 *  the link resolves under the project base; no index at all when `index`
 *  is null. */
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

/** A docs/ with an article and no landing page: the shape a repository's
 *  first tag carries when the listing came before the README. */
function docsWithoutLanding(repo: string): void {
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "store-listing.md"), "# Store listing\n\nBlurb.\n");
}

const NO_LINK_ROT = { "link-rot-label": "", "link-rot-color": "", "link-rot-description": "" };

describe("the layout a deploy lands", () => {
  // A tag without a landing page is skipped with a notice, not a failed deploy; RUNNER_TEMP is
  // a symlink here on purpose (fixtures.ts), the shape under which every internal link once read dead.
  test.each<{
    layout: string;
    fixture: (repo: string) => void;
    env: Record<string, string>;
    /** Regular files under the site, each with a substring it carries. */
    pages: [string, string][];
    /** Paths under the site that must not exist; "." is the site directory itself. */
    absent: string[];
    /** The docs mount's versions.json labels, where a mount was laid out. */
    versions: [string, string[]] | null;
    stdout: (string | RegExp)[];
    outputs: (site: string) => Record<string, string>;
  }>([
    {
      layout:
        "website and docs: the website at the root, the docs versioned under the docs path, a landing-less tag skipped, versions.json only there",
      fixture: (repo) => {
        website(repo, { marker: "WEBSITE-ROOT", docsPath: "manual" });
        docsWithoutLanding(repo);
        initRepo(repo);
        commitAll(repo, "site and a docs listing");
        fixtureGit(repo, ["tag", "v0.9.0"]);
        docs(repo);
        commitAll(repo, "the docs landing page");
        fixtureGit(repo, ["tag", "v1.0.0"]);
      },
      env: {
        SITE_DIR: "dist",
        CONFIG: siteConfig({ site_title: "Site Docs", docs_path: "manual", link_rot_label: "rot" }),
      },
      pages: [
        ["index.html", "WEBSITE-ROOT"],
        ["assets/app.js", "console.log(1)"],
        ["manual/index.html", "The docs landing page."],
        ["manual/latest/index.html", "The docs landing page."],
        ["manual/latest/index.html", 'href="/site-repo/manual/latest/'],
        ["manual/v1.0.0/index.html", "The docs landing page."],
      ],
      absent: ["manual/v0.9.0", "versions.json"],
      versions: ["manual", ["latest", "v1.0.0"]],
      stdout: [
        "::notice::docs version v0.9.0 skipped: docs/ has no landing page (README.md or index.md) at that tag",
        /internal links resolve \(\d+ links judged across \d+ current pages\)/,
      ],
      outputs: (site) => ({
        ...NO_LINK_ROT,
        "publish": "true",
        "site-dir": site,
        "link-rot-label": "rot",
        "site-title": "Site Docs",
      }),
    },
    {
      layout:
        "website alone: one copy at the root, no version layout, the configured title verbatim",
      fixture: (repo) => {
        website(repo, null);
        writeFileSync(
          join(repo, "dist", "index.html"),
          "<html><body>WEBSITE-ALONE</body></html>\n",
        );
        initRepo(repo);
        commitAll(repo, "site only");
      },
      env: { SITE_DIR: "dist" },
      pages: [["index.html", "WEBSITE-ALONE"]],
      absent: ["versions.json", "latest"],
      versions: null,
      stdout: [],
      outputs: (site) => ({
        ...NO_LINK_ROT,
        "publish": "true",
        "site-dir": site,
        "site-title": SITE_TITLE,
      }),
    },
    {
      layout:
        "neither a hook directory nor docs/: green, a notice, publish false, no site directory",
      fixture: (repo) => {
        writeFileSync(join(repo, "README.md"), "# Bare\n");
        initRepo(repo);
        commitAll(repo, "no site");
      },
      env: {},
      pages: [],
      absent: ["."],
      versions: null,
      stdout: [
        "::notice::nothing to publish: the site-build hook named no directory and the repository has no docs/",
      ],
      outputs: () => ({
        ...NO_LINK_ROT,
        "publish": "false",
        "site-dir": "",
        "site-title": SITE_TITLE,
      }),
    },
  ])(
    "$layout",
    (row) => {
      const workspace = temp.dir("pages-site-layout-");
      row.fixture(workspace);
      const runner = runnerTemp(temp);
      const result = buildSite(workspace, REPO, runner, row.env);
      expect(result.exitCode, describeRun(result)).toBe(0);
      const site = runner.site;
      const missing = row.pages.filter(
        ([rel, text]) => !(isFile(site, rel) && readSite(site, rel).includes(text)),
      );
      expect(missing).toEqual([]);
      expect(present(site, row.absent)).toEqual([]);
      if (row.versions !== null) {
        expect(versionLabels(join(site, row.versions[0]))).toEqual(row.versions[1]);
      }
      for (const line of row.stdout) expect(result.stdout).toMatch(line);
      expect(outputs(result.stdout)).toEqual(row.outputs(site));
    },
    TEST_TIMEOUT_MS,
  );
});

describe("a refused layout", () => {
  // Both messages are pinned as values in pages-site.test.ts; what the run adds is the order:
  // the refusal lands before any docs tier builds, so no half-built site is handed on.
  test.each<{
    reason: string;
    fixture: (repo: string) => void;
    env: Record<string, string>;
    message: string;
  }>([
    {
      reason: "a docs/ whose landing is index.md alone, naming docs/README.md",
      fixture: (repo) => {
        mkdirSync(join(repo, "docs"), { recursive: true });
        writeFileSync(join(repo, "docs", "index.md"), "# Home\n");
        initRepo(repo);
        commitAll(repo, "index.md landing");
      },
      env: { CHECK: "true" },
      message: "docs/README.md does not exist - it is the docs landing page; create it",
    },
    {
      reason: "a dist without index.html",
      fixture: (repo) => {
        website(repo, null);
        docs(repo);
        initRepo(repo);
        commitAll(repo, "site without an index");
      },
      env: { SITE_DIR: "dist" },
      message: "the site-build hook's dist 'dist' produced no index.html, so its own URL would 404",
    },
  ])(
    "refuses $reason before any build",
    ({ fixture, env, message }) => {
      const workspace = temp.dir("pages-site-refused-");
      fixture(workspace);
      expectRefusedBeforeBuild(buildSite(workspace, REPO, runnerTemp(temp), env), message);
    },
    TEST_TIMEOUT_MS,
  );
});
