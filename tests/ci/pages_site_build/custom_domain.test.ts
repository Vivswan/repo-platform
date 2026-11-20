// One deploy build of a repository served under a custom domain: GitHub serves it at the domain's root, whatever the
// repository is named. Laid out under /<repo>/ by the rule, the deployed pages would ask for every asset and version at
// a path the domain 404s.

import { beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureGit } from "../../shared/fixture_git.ts";
import { tempDirs } from "../../shared/temp_dir.ts";
import {
  type BuildResult,
  buildSite,
  commitAll,
  describeRun,
  FLEET_REPO,
  initRepo,
  linkCheckRemap,
  ownedBy,
  present,
  type RunnerTemp,
  readSite,
  runnerTemp,
  TEST_TIMEOUT_MS,
} from "./fixtures.ts";
import { hrefs, select } from "./html.ts";

const temp = tempDirs();

let runner: RunnerTemp;
let result: BuildResult;

beforeAll(() => {
  const repo = temp.dir("pages-site-domain-");
  mkdirSync(join(repo, "dist"), { recursive: true });
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "dist", "index.html"), "<html><body>DOMAIN-SITE</body></html>\n");
  writeFileSync(join(repo, "docs", "README.md"), "# Home\n");
  initRepo(repo);
  commitAll(repo, "site");
  fixtureGit(repo, ["tag", "v1.0.0"]);
  runner = runnerTemp(temp, "/");
  result = buildSite(repo, FLEET_REPO, runner, {
    SITE_DIR: "dist",
    SITE_URL: "https://docs.example.com",
  });
}, TEST_TIMEOUT_MS);

test("is assembled at the served root, its asset URLs and version links under the domain's root and none under the repository's name", () => {
  expect(result.exitCode, describeRun(result)).toBe(0);
  expect(result.outputs["site-dir"]).toBe(runner.served);
  expect(present(runner.served, ["index.html", "docs/latest/index.html", "fixture-repo"])).toEqual([
    "index.html",
    "docs/latest/index.html",
  ]);
  const page = readSite(runner.site, "docs/latest/index.html");
  const assets = select(page, "script[src], link[href]")
    .map((element) => element.attrs.src ?? element.attrs.href)
    .filter((url) => url.includes("/assets/"));
  expect(new Set(assets.map((url) => url.slice(0, url.indexOf("assets/"))))).toEqual(
    new Set(["/docs/latest/"]),
  );
  expect(hrefs(page, ".VPNavBarMenuGroup .VPMenuLink a")).toEqual(
    ["latest", "stable", "v1.0.0"].map((label) => `https://docs.example.com/docs/${label}/`),
  );
  expect(
    ownedBy(linkCheckRemap(runner).pattern, {
      root: "https://docs.example.com/",
      docs: "https://docs.example.com/docs/latest/",
      githubIo: "https://fixture-owner.github.io/fixture-repo/docs/latest/",
    }),
  ).toEqual({ root: true, docs: true, githubIo: false });
});
