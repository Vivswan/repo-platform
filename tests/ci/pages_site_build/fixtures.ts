// The pages-site build driven as the runner drives it: workspace, action
// checkout, and RUNNER_TEMP in three separate trees. The pages' SSR
// imports resolve by walking up from the SOURCE files, so a docs tree
// materialized outside the build root only reaches the action's
// node_modules when the build copies it there - a laptop layout with the
// repo near the dependencies cannot see that class, this topology can.

import { expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fill, loadAction, stepNamed } from "../../shared/action_step.ts";
import { boundedSpawnSync } from "../../shared/bounded_spawn.ts";
import { fixtureGit } from "../../shared/fixture_git.ts";
import { harnessBound } from "../../shared/harness_bound.ts";
import type { TempDirs } from "../../shared/temp_dir.ts";

export const BUILD_TS = resolve(import.meta.dir, "../../../actions/pages-site/build.ts");

/** A vitepress build of four tiers runs well under this on CI runners; it
 *  is a hang bound, not a deadline (boundedSpawnSync stretches it for load). */
export const BUILD_TIMEOUT_MS = 180_000;
export const TEST_TIMEOUT_MS = harnessBound(200_000);

export const SITE_TITLE = "Fixture Site";

/** The CONFIG env the action step sets, from the plan or the caller. */
export function siteConfig(
  overrides: Partial<{
    site_title: string;
    docs_path: string;
    include: { path: string; mount: string; page: string }[];
    link_rot_label: string;
  }> = {},
): string {
  return JSON.stringify({
    site_title: SITE_TITLE,
    docs_path: "docs",
    include: [],
    link_rot_label: "",
    link_rot_color: "",
    link_rot_description: "",
    ...overrides,
  });
}

export interface RunnerTemp {
  /** What RUNNER_TEMP is set to: a SYMLINK to the real directory. macOS
   *  /tmp is such an alias, and a build that does not realpath its scratch
   *  base sees the build root under two spellings, on which vitepress's
   *  path-keyed route resolution reports every internal link dead. */
  alias: string;
  /** The assembled artifact, under the real path: the build's scratch
   *  directory, then the served root, then the repository's base path. */
  site: string;
}

export function runnerTemp(temp: TempDirs, repository: string): RunnerTemp {
  const real = temp.dir("pages-site-temp-");
  const alias = join(temp.dir("pages-site-alias-"), "alias");
  symlinkSync(real, alias);
  const repo = repository.split("/")[1];
  return { alias, site: join(realpathSync(real), "pages-site", "served", repo) };
}

/** The `link-check-args` output a deploy of `repository` emits for `runner`'s layout: the artifact's root, the page
 *  list in the scratch directory, and the site's own links remapped into the artifact. */
export function deployLinkCheckArgs(runner: RunnerTemp, repository: string): string {
  const [owner, repo] = repository.split("/");
  const scratch = dirname(dirname(runner.site));
  return (
    `--root-dir '${dirname(runner.site)}' --files-from '${join(scratch, "link-check-inputs.txt")}' ` +
    `--remap '^https://${owner.toLowerCase()}\\.github\\.io/${repo}([/?#]|$) file://${runner.site}$1'`
  );
}

const LINK_CHECK_STEP = stepNamed(
  loadAction("actions/pages-site/action.yml"),
  "Check the site's internal links",
) as { with: { args: string; lycheeVersion: string } };

/** The lychee the action's link-check step pins, when it is on PATH; null, and the live run is skipped loudly. A
 *  lychee that cannot print its version is broken, not absent. */
export function pinnedLychee(): string | null {
  const pinned = `lychee ${LINK_CHECK_STEP.with.lycheeVersion.replace(/^v/, "")}`;
  const path = Bun.which("lychee");
  if (path === null) {
    console.warn(
      `${pinned} is not on PATH: the live link check is skipped here and runs in the action`,
    );
    return null;
  }
  const version = boundedSpawnSync([path, "--version"]);
  if (version.exitCode !== 0) {
    throw new Error(`${path} --version exited ${version.exitCode}:\n${version.stderr}`);
  }
  const printed = version.stdout.trim();
  if (printed === pinned) return path;
  console.warn(
    `${path} is ${printed}, not ${pinned}: the live link check is skipped here and runs in the action`,
  );
  return null;
}

/** The step's lychee run the way lychee-action's entrypoint runs it (bash evals the args string), the markdown
 *  report on stdout. */
export function runLinkCheck(lychee: string, linkCheckArgs: string, cwd: string): BuildResult {
  const args = fill(LINK_CHECK_STEP.with.args, {
    "${{ steps.assemble.outputs.link-check-args }}": linkCheckArgs,
  });
  return boundedSpawnSync(["bash", "-c", `'${lychee}' --format markdown ${args}`], { cwd });
}

export interface BuildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function buildSite(
  workspace: string,
  repository: string,
  runner: RunnerTemp,
  env: Record<string, string>,
): BuildResult {
  return boundedSpawnSync([process.execPath, BUILD_TS], {
    env: {
      ...process.env,
      GITHUB_WORKSPACE: workspace,
      GITHUB_REPOSITORY: repository,
      RUNNER_TEMP: runner.alias,
      GITHUB_OUTPUT: "",
      CONFIG: siteConfig(),
      SITE_DIR: "",
      ...env,
    },
    timeoutMs: BUILD_TIMEOUT_MS,
  });
}

/** A failure message that carries the build's own output, so a red build
 *  names its cause instead of only its exit code. */
export function describeRun(result: BuildResult): string {
  return `exit ${result.exitCode}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`;
}

/** The step outputs the build set, read from the lines GITHUB_OUTPUT="" makes it print. */
export function outputs(stdout: string): Record<string, string> {
  return Object.fromEntries(
    [...stdout.matchAll(/^\(output\) ([a-z-]+)=(.*)$/gm)].map((match) => [match[1], match[2]]),
  );
}

/** A refusal lands before any build and any output, so no half-built site is handed on. */
export function expectRefusedBeforeBuild(result: BuildResult, message: string): void {
  expect(result.exitCode, describeRun(result)).toBe(1);
  expect(result.stderr).toContain(`::error::${message}`);
  expect(result.stdout).not.toMatch(/vitepress|building docs tier/);
  expect(outputs(result.stdout)).toEqual({});
}

export function present(site: string, rels: string[]): string[] {
  return rels.filter((rel) => existsSync(join(site, rel)));
}

export function commitAll(repo: string, message: string): void {
  const identity = ["-c", "user.name=fixture", "-c", "user.email=f@localhost"];
  fixtureGit(repo, [...identity, "add", "-A"]);
  fixtureGit(repo, [...identity, "commit", "-qm", message]);
}

export function revertHead(repo: string): void {
  fixtureGit(repo, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=f@localhost",
    "revert",
    "--no-edit",
    "HEAD",
  ]);
}

export function initRepo(repo: string): void {
  fixtureGit(repo, ["init", "-q", "-b", "main"]);
}

/** A regular file at `site/rel`: a directory of that name is not the
 *  artifact (existsSync would accept it). */
export function isFile(site: string, rel: string): boolean {
  try {
    return statSync(join(site, rel)).isFile();
  } catch {
    return false;
  }
}

export function readSite(site: string, rel: string): string {
  return readFileSync(join(site, rel), "utf-8");
}

/** Every file under `site/rel` by name with its text: the built CSS and JS
 *  land as hashed names, so an assertion on a rule, an inlined index, or
 *  which chunk holds what scans the whole assets directory. */
export function assetFiles(site: string, rel: string): { name: string; text: string }[] {
  const dir = join(site, rel);
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      name: entry.name,
      text: readFileSync(join(entry.parentPath, entry.name), "utf-8"),
    }));
}

export function readAssets(site: string, rel: string): string {
  return assetFiles(site, rel)
    .map((file) => file.text)
    .join("\n");
}

export function versionLabels(site: string): string[] {
  const index = JSON.parse(readSite(site, "versions.json")) as { versions: { label: string }[] };
  return index.versions.map((entry) => entry.label);
}

const ESC = "\x1b";

/** Every custom-block kind the theme styles, both syntaxes: GitHub alerts
 *  (retitled in sentence case by custom-blocks.ts) and ::: containers,
 *  plus a highlighted code block, an ansi fence (the one language shiki
 *  colors from the theme's terminal palette, not its token colors), and a
 *  mermaid fence whose `{{ }}` hexagon would fail the build as a Vue
 *  interpolation without the mount's v-pre. */
const ALERTS_MD = [
  "# Alerts",
  "",
  "> [!NOTE]",
  "> a note",
  "",
  "> [!TIP]",
  "> a tip",
  "",
  "> [!IMPORTANT]",
  "> important",
  "",
  "> [!WARNING]",
  "> a warning",
  "",
  "> [!CAUTION]",
  "> caution",
  "",
  "::: info",
  "info",
  ":::",
  "",
  "::: danger",
  "danger",
  ":::",
  "",
  "::: details Show",
  "hidden",
  ":::",
  "",
  "```ts",
  "// c",
  'const s = "x";',
  "```",
  "",
  "```ansi",
  `${ESC}[31mERROR${ESC}[0m plain`,
  "```",
  "",
  "```mermaid",
  "graph TD",
  '  A["x <b>& y</b>"] -->|"go"| B{{done}}',
  "```",
  "",
].join("\n");

/** The built mermaid mount: the source once, HTML-escaped, inside the
 *  fallback pre (the client reads it back as text). */
export const MERMAID_MOUNT_HTML =
  '<div class="fleet-mermaid"><pre class="fleet-mermaid-source">' +
  "graph TD\n  A[&quot;x &lt;b&gt;&amp; y&lt;/b&gt;&quot;] --&gt;|&quot;go&quot;| B{{done}}" +
  "</pre></div>";

const SETUP_MD =
  "# Setup\n\nInstall things.\n\n| Step | Command |\n|---|---|\n| One | run it |\n\n" +
  "## Install steps\n\nOne, then two.\n\n## Upgrade steps\n\nThree.\n";

/** The HEAD-only pages exercise sidebar placement: zulu.md ranks by
 *  `order` and opens the Basics group, alpha.md joins it by name alone,
 *  setup.md is placed by the landing table, bravo.md by nothing. */
export function docsFixture(repo: string): void {
  mkdirSync(join(repo, "docs", "guide"), { recursive: true });
  writeFileSync(
    join(repo, "docs", "README.md"),
    "# Fixture\n\nWelcome. See the [guide](guide/) and [setup](setup).\n\n" +
      "| Goal | Read |\n|---|---|\n| Set things up | [Setup](setup.md) |\n",
  );
  writeFileSync(join(repo, "docs", "setup.md"), SETUP_MD);
  writeFileSync(join(repo, "docs", "alerts.md"), ALERTS_MD);
  writeFileSync(
    join(repo, "docs", "guide", "README.md"),
    "# Guide\n\nThe guide index, version one.\n",
  );
  initRepo(repo);
  commitAll(repo, "v1 docs");
  fixtureGit(repo, ["tag", "v0.1.0"]);

  mkdirSync(join(repo, "docs", "zh-cn"));
  writeFileSync(join(repo, "docs", "zh-cn", "README.md"), "# Fixture zh\n\nlocale landing page\n");
  writeFileSync(
    join(repo, "docs", "guide", "README.md"),
    "# Guide\n\nThe guide index, version one.\nSecond version line.\n",
  );
  commitAll(repo, "v2 docs + locale");
  fixtureGit(repo, ["tag", "v0.2.0"]);

  writeFileSync(join(repo, "docs", "setup.md"), `${SETUP_MD}HEAD-only line.\n`);
  writeFileSync(
    join(repo, "docs", "zulu.md"),
    "---\norder: 1\ngroup: Basics\n---\n\n# Zulu\n\nRanked.\n",
  );
  writeFileSync(join(repo, "docs", "alpha.md"), "---\ngroup: Basics\n---\n\n# Alpha\n\nGrouped.\n");
  writeFileSync(join(repo, "docs", "bravo.md"), "# Bravo\n\nUnplaced.\n");
  commitAll(repo, "head docs");
}

export function appendDeadLink(repo: string): void {
  const setup = join(repo, "docs", "setup.md");
  writeFileSync(setup, `${readFileSync(setup, "utf-8")}\nA [dead link](missing-page).\n`);
}
