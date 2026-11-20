// The deploys vitepress has no part in: a hook's website alone, a repository with nothing to publish, and a user
// site, each assembled from the hook's directory as it stands.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../shared/temp_dir.ts";
import { uvOnPath } from "../../shared/uv_project.ts";
import {
  type BuildResult,
  buildSite,
  commitAll,
  deployLinkCheckArgs,
  describeRun,
  FLEET_BASE,
  FLEET_REPO,
  initRepo,
  isFile,
  linkCheckRemap,
  ownedBy,
  present,
  type RunnerTemp,
  readSite,
  runLinkCheck,
  runnerTemp,
  SITE_TITLE,
  siteConfig,
  TEST_TIMEOUT_MS,
} from "./fixtures.ts";

const temp = tempDirs();

describe("layouts that build no docs tier", () => {
  // docs/modules/site.md's two Layout rows a deploy settles without vitepress; the refused layouts are resolvePrebuilt's
  // and assertDocsLanding's unit tables. An absent path of "." is the site directory itself.
  const NO_LINK_ROT = { "link-rot-label": "", "link-rot-color": "", "link-rot-description": "" };
  test.each<{
    layout: string;
    fixture: (repo: string) => void;
    env: Record<string, string>;
    pages: [string, string][];
    absent: string[];
    stdout: string[];
    outputs: (runner: RunnerTemp) => Record<string, string>;
  }>([
    {
      layout:
        "website alone: one copy at the root, no version layout, the configured title verbatim",
      fixture: (repo) => {
        mkdirSync(join(repo, "dist"), { recursive: true });
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
      stdout: [],
      outputs: (runner) => ({
        ...NO_LINK_ROT,
        "publish": "true",
        "site-dir": runner.site,
        "link-check-args": deployLinkCheckArgs(runner),
        "link-rot-ignore": join(runner.scratch, "link-rot.lycheeignore"),
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
      stdout: [
        "::notice::nothing to publish: the site-build hook named no directory and the repository has no docs/",
      ],
      outputs: () => ({
        ...NO_LINK_ROT,
        "publish": "false",
        "site-dir": "",
        "link-check-args": "",
        "link-rot-ignore": "",
        "site-title": SITE_TITLE,
      }),
    },
  ])("$layout", (row) => {
    const repo = temp.dir("pages-site-layout-");
    row.fixture(repo);
    const runner = runnerTemp(temp, FLEET_BASE);
    const result = buildSite(repo, FLEET_REPO, runner, row.env);
    expect(result.exitCode, describeRun(result)).toBe(0);
    expect(result.stdout).not.toMatch(/vitepress|building docs tier/);
    const missing = row.pages.filter(
      ([rel, text]) => !(isFile(runner.site, rel) && readSite(runner.site, rel).includes(text)),
    );
    expect(missing).toEqual([]);
    expect(present(runner.site, row.absent)).toEqual([]);
    for (const line of row.stdout) expect(result.stdout).toContain(line);
    expect(result.outputs).toEqual(row.outputs(runner));
  });
});

describe("a user site", () => {
  // GitHub serves the repository named <owner>.github.io, in whatever case, at the origin's root. Laid out under
  // /<repo>/ like a project site, the hook would build for a base path Pages never serves, and lychee would resolve
  // every root-absolute link under a directory the page is not in.
  const USER_SITE_REPO = "fixture-owner/Fixture-Owner.github.io";
  let runner: RunnerTemp;
  let result: BuildResult;

  beforeAll(() => {
    const repo = temp.dir("pages-site-user-");
    mkdirSync(join(repo, "dist"), { recursive: true });
    writeFileSync(
      join(repo, "dist", "index.html"),
      '<html><head><link rel="icon" href="/favicon.ico"></head><body>USER-SITE ' +
        '<a href="https://fixture-owner.github.io/about">about</a> ' +
        '<a href="https://fixture-owner.github.io/my%20page">a page with a space in its name</a> ' +
        '<a href="https://fixture-owner.github.io/other-project/">a project site</a></body></html>\n',
    );
    writeFileSync(join(repo, "dist", "favicon.ico"), "");
    writeFileSync(join(repo, "dist", "about.html"), "<html><body>About</body></html>\n");
    writeFileSync(join(repo, "dist", "my page.html"), "<html><body>Spaced</body></html>\n");
    writeFileSync(
      join(repo, ".lycheeignore"),
      "# hosts behind a bot wall\n^https://example\\.invalid/\n",
    );
    initRepo(repo);
    commitAll(repo, "user site");
    runner = runnerTemp(temp, "/");
    result = buildSite(repo, USER_SITE_REPO, runner, {
      SITE_DIR: "dist",
      CONFIG: siteConfig({ docs_path: null }),
    });
  });

  // The origin is shared with the owner's project sites (https://owner.github.io/<repo>/), so own links are the
  // artifact's top-level entries, not the origin: a user site's deploy once failed on its link to a sibling project
  // site, read as a missing page of the artifact. A link is read as its author spelled it, so an entry matches every
  // percent-spelling of its name.
  test("is assembled at the served root itself, the directory uploaded and lychee's root, owning its own entries on the bare origin", () => {
    expect(result.exitCode, describeRun(result)).toBe(0);
    expect(runner.site).toBe(runner.served);
    expect(readSite(runner.site, "index.html")).toContain("USER-SITE");
    expect(result.outputs).toMatchObject({
      "publish": "true",
      "site-dir": runner.served,
      "link-check-args": deployLinkCheckArgs(runner),
      "link-rot-ignore": join(runner.scratch, "link-rot.lycheeignore"),
    });
    const remap = linkCheckRemap(runner);
    expect(remap.replacement).toBe(`${Bun.pathToFileURL(runner.served).href}$1`);
    // The crawl's ignore list: the own links first, then the repository's own list as it stands.
    expect(readFileSync(join(runner.scratch, "link-rot.lycheeignore"), "utf-8")).toBe(
      `${remap.pattern}\n# hosts behind a bot wall\n^https://example\\.invalid/\n`,
    );
    expect(
      ownedBy(remap.pattern, {
        root: "https://fixture-owner.github.io/",
        bareOrigin: "https://fixture-owner.github.io",
        page: "https://fixture-owner.github.io/about",
        pageHtml: "https://fixture-owner.github.io/about.html",
        spaced: "https://fixture-owner.github.io/my%20page",
        spacedOtherCase: "https://fixture-owner.github.io/my%20PAGE",
        spacedEncodedLetters: "https://fixture-owner.github.io/%6dy%20page",
        icon: "https://fixture-owner.github.io/favicon.ico",
        sibling: "https://fixture-owner.github.io/other-project/",
        prefixOfAPage: "https://fixture-owner.github.io/about-us",
      }),
    ).toEqual({
      root: true,
      bareOrigin: true,
      page: true,
      pageHtml: true,
      spaced: true,
      spacedOtherCase: false,
      spacedEncodedLetters: true,
      icon: true,
      sibling: false,
      prefixOfAPage: false,
    });
  });

  test.skipIf(!uvOnPath())(
    "lychee resolves its root-absolute link and its origin-spelled links (one percent-encoded) in the artifact, and leaves the sibling project site's link to the network",
    () => {
      const check = runLinkCheck(result.outputs["link-check-args"], runner);
      expect([check.exitCode, check.outputs["exit-code"]], describeRun(check)).toEqual([0, "0"]);
      expect(check.report).toContain("| ✅ Successful  | 3     |");
      expect(check.report).not.toContain("other-project");
    },
    TEST_TIMEOUT_MS,
  );
});
