import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureGit } from "../../shared/fixture_git.ts";
import { tempDirs } from "../../shared/temp_dir.ts";
import {
  buildSite,
  COMMAND_MOUNT,
  commitAll,
  describeRun,
  initRepo,
  readSite,
  revertHead,
  runnerTemp,
  TEST_TIMEOUT_MS,
  versionLabels,
} from "./fixtures.ts";

const temp = tempDirs();

const COMMAND_ENV = { MOUNTS: COMMAND_MOUNT, BUILD_COMMAND: "bun run build:site" };

function buildScript(marker: string): string {
  // The fixture builds echo the tier contract into the page, so the layout
  // asserts what each build was told, not only what it produced; the
  // shell expands $PAGES_TIER at build time.
  return `mkdir -p dist && echo ${marker} tier=$PAGES_TIER > dist/index.html`;
}

function packageJson(repo: string, scripts: Record<string, string> | undefined): void {
  writeFileSync(
    join(repo, "package.json"),
    `${JSON.stringify(scripts ? { name: "cmd-fixture", scripts } : { name: "cmd-fixture" })}\n`,
  );
}

/** A command-mount repository whose history crosses the line the deploy
 *  must draw: v1.0.0 predates the build script (structurally unbuildable
 *  forever, so skipped with a notice), v1.1.0 declares it, v1.1.1 declares
 *  it behind a SYMLINKED package.json, and HEAD declares it again. */
function commandFixture(repo: string): void {
  packageJson(repo, { test: "true" });
  initRepo(repo);
  commitAll(repo, "before the site existed");
  fixtureGit(repo, ["tag", "v1.0.0"]);
  packageJson(repo, { "build:site": buildScript("SCRIPT-ERA") });
  commitAll(repo, "add the site build");
  fixtureGit(repo, ["tag", "v1.1.0"]);
  // The link's TARGET is a file literally named '{"scripts": {}}': target
  // text that parses as script-less JSON, so a mode-blind reader judging
  // the link text as content would falsely skip this tag; bun follows the
  // link at build time, so the probe must stay inconclusive and BUILD it.
  const linkTarget = '{"scripts": {}}';
  writeFileSync(
    join(repo, linkTarget),
    '{"name": "cmd-fixture", "scripts": {"build:site": "mkdir -p dist && echo LINK-ERA > dist/index.html"}}\n',
  );
  unlinkSync(join(repo, "package.json"));
  symlinkSync(linkTarget, join(repo, "package.json"));
  commitAll(repo, "symlinked package.json");
  fixtureGit(repo, ["tag", "v1.1.1"]);
  unlinkSync(join(repo, "package.json"));
  unlinkSync(join(repo, linkTarget));
  packageJson(repo, { "build:site": buildScript("HEAD-ERA") });
  commitAll(repo, "head-only build output");
}

describe("command mounts over legacy tags", () => {
  test(
    "skips a pre-script tag with a notice and builds every tag that declares the script",
    () => {
      const workspace = temp.dir("pages-site-command-");
      commandFixture(workspace);
      const runner = runnerTemp(temp);
      const result = buildSite(workspace, "fixture-owner/cmd-repo", runner, COMMAND_ENV);
      expect(result.exitCode, describeRun(result)).toBe(0);
      expect(result.stdout).toContain("::notice::site version v1.0.0 skipped");
      expect(existsSync(join(runner.site, "v1.0.0"))).toBe(false);
      expect(readSite(runner.site, "v1.1.0/index.html")).toContain("SCRIPT-ERA tier=tag");
      expect(readSite(runner.site, "v1.1.1/index.html")).toContain("LINK-ERA");
      const root = readSite(runner.site, "index.html");
      expect(root).toContain("LINK-ERA");
      expect(root).not.toContain("HEAD-ERA");
      expect(readSite(runner.site, "latest/index.html")).toContain("HEAD-ERA tier=latest");
      expect(versionLabels(runner.site)).toEqual(["latest", "v1.1.1", "v1.1.0"]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a tag whose declared build script fails stays fatal",
    () => {
      // The skip is structural (no script anywhere), never a catch-all:
      // a broken script sealed into a tag must turn the deploy red.
      const workspace = temp.dir("pages-site-fatal-");
      commandFixture(workspace);
      packageJson(workspace, { "build:site": "exit 1" });
      commitAll(workspace, "seal a broken build into history");
      fixtureGit(workspace, ["tag", "v1.2.0"]);
      revertHead(workspace);
      const result = buildSite(workspace, "fixture-owner/cmd-repo", runnerTemp(temp), COMMAND_ENV);
      expect(result.exitCode, describeRun(result)).not.toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "when every tag predates the script, the root is a second build of HEAD and versions.json lists latest alone",
    () => {
      // The root is the one copy a site indexes, so it must be a real page,
      // not a redirect stub.
      const workspace = temp.dir("pages-site-allskip-");
      packageJson(workspace, undefined);
      initRepo(workspace);
      commitAll(workspace, "before the site existed");
      fixtureGit(workspace, ["tag", "v0.9.0"]);
      packageJson(workspace, { "build:site": buildScript("ALLSKIP-HEAD") });
      commitAll(workspace, "add the site build");
      const runner = runnerTemp(temp);
      const result = buildSite(workspace, "fixture-owner/allskip-repo", runner, COMMAND_ENV);
      expect(result.exitCode, describeRun(result)).toBe(0);
      expect(result.stdout).toContain("::notice::no version tags to serve");
      expect(readSite(runner.site, "index.html")).toContain("ALLSKIP-HEAD tier=root");
      expect(readSite(runner.site, "latest/index.html")).toContain("ALLSKIP-HEAD tier=latest");
      expect(versionLabels(runner.site)).toEqual(["latest"]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a command HEAD resolves through PATH without declaring keeps every tag building",
    () => {
      // The HEAD calibration gate: when HEAD itself never declares the
      // script, skipping is not armed, scripts-less package.json and all.
      const root = temp.dir("pages-site-pathbin-");
      const bin = join(root, "bin");
      const workspace = join(root, "repo");
      mkdirSync(bin);
      mkdirSync(workspace);
      writeFileSync(
        join(bin, "makedist"),
        "#!/usr/bin/env bash\nmkdir -p dist && echo PATH-ERA > dist/index.html\n",
      );
      chmodSync(join(bin, "makedist"), 0o755);
      writeFileSync(
        join(workspace, "package.json"),
        '{"name": "pathbin-fixture", "scripts": {}}\n',
      );
      initRepo(workspace);
      commitAll(workspace, "no script anywhere");
      fixtureGit(workspace, ["tag", "v0.1.0"]);
      const runner = runnerTemp(temp);
      const result = buildSite(workspace, "fixture-owner/pathbin-repo", runner, {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        MOUNTS: COMMAND_MOUNT,
        BUILD_COMMAND: "bun run makedist",
      });
      expect(result.exitCode, describeRun(result)).toBe(0);
      expect(readSite(runner.site, "v0.1.0/index.html")).toContain("PATH-ERA");
      expect(result.stdout + result.stderr).not.toContain("::notice::site version");
    },
    TEST_TIMEOUT_MS,
  );
});
