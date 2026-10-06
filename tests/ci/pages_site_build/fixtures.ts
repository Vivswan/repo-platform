// The pages-site build driven as the runner drives it: workspace, action
// checkout, and RUNNER_TEMP in three separate trees. The pages' SSR
// imports resolve by walking up from the SOURCE files, so a docs tree
// materialized outside the build root only reaches the action's
// node_modules when the build copies it there - a laptop layout with the
// repo near the dependencies cannot see that class, this topology can.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
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

/** A vitepress build of five tiers runs well under this on CI runners; it
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
 *  list in the scratch directory, and the site's own links remapped into the artifact. Each value is quoted the way
 *  `Bun.$.escape` quotes for bash, the origin spelled the way `RegExp.escape` spells it (the fixture owner's hyphen is
 *  a hex escape); the live lychee run is what proves bash and Rust read both. */
export function deployLinkCheckArgs(runner: RunnerTemp, repository: string): string {
  const [owner, repo] = repository.split("/");
  const scratch = dirname(dirname(runner.site));
  const own = RegExp.escape(`https://${owner.toLowerCase()}.github.io/${repo}`);
  return (
    `--root-dir ${Bun.$.escape(dirname(runner.site))} ` +
    `--files-from ${Bun.$.escape(join(scratch, "link-check-inputs.txt"))} ` +
    `--remap ${Bun.$.escape(`^${own}([/?#]|$) file://${runner.site}$1`)}`
  );
}

/** The pages the build listed for lychee, relative to the site. */
export function linkCheckInputs(runner: RunnerTemp): string[] {
  const scratch = dirname(dirname(runner.site));
  return readFileSync(join(scratch, "link-check-inputs.txt"), "utf-8")
    .trimEnd()
    .split("\n")
    .map((line) => line.slice(runner.site.length + 1));
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

export function present(site: string, rels: string[]): string[] {
  return rels.filter((rel) => existsSync(join(site, rel)));
}

export function commitAll(repo: string, message: string): void {
  const identity = ["-c", "user.name=fixture", "-c", "user.email=f@localhost"];
  fixtureGit(repo, [...identity, "add", "-A"]);
  fixtureGit(repo, [...identity, "commit", "-qm", message]);
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

/** The sealed dead link: history cannot be fixed, so the tag carrying it builds lenient. */
export const SEALED_DEAD_LINK = "A [dead link](missing-page).\n";

/** The docs landing page: an intro, then a section holding a link table the way a fleet README may still carry one,
 *  and links into the skills mount once it exists. The HEAD page links a heading that does not exist, which vitepress
 *  never judges and lychee reports. */
function docsReadme(skills: string): string {
  return (
    "# Fixture\n\nWelcome. See the [guide](guide/) and [setup](setup).\n\n## Goals\n\n" +
    "| Goal | Read |\n|---|---|\n| Set things up | [Setup](setup.md) |\n" +
    skills
  );
}
const SKILL_LINKS_AT_TAG =
  "\nSee the [alpha skill](skills/alpha/) and how to [install it](skills/alpha/#install).\n";
const SKILL_LINKS_AT_HEAD =
  "\nSee the [skills](skills/), the [alpha skill](skills/alpha/), how to " +
  "[install it](skills/alpha/#install), and [nothing](skills/alpha/#nope).\n";

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

/** The agent links the skill back in repository space; the skill links the agent the same way at HEAD. */
const ONE_AGENT =
  "---\nname: one\n---\n\nUses the [alpha skill](../../skills/alpha/SKILL.md#install).\n";

export const FLEET_REPO = "fixture-owner/fixture-repo";

/** The include roots as a registration lists them, child first: a staging that followed list order would land
 *  agents/ where its parent has yet to be copied. */
export const FLEET_INCLUDE = [
  { path: "agents", mount: "skills/agents", page: "AGENT.md" },
  { path: "skills", mount: "skills", page: "SKILL.md" },
];

export const FLEET_ENV = {
  SITE_DIR: "dist",
  CONFIG: siteConfig({ site_title: "Fixture Docs", include: FLEET_INCLUDE, link_rot_label: "rot" }),
};

/** The hook's dist: the website's page links INTO the docs mount, an include page among them and an extensionless
 *  path as Pages serves it; a sibling site of the same owner is not this artifact's to judge. Two links are dead on
 *  purpose, one on a page named with a glob metacharacter (lychee would read its raw path as a pattern and skip it
 *  silently): the check over the assembled artifact is the only judge of a website link into the docs. */
function website(repo: string): void {
  const links = [
    '<a href="/fixture-repo/docs/">docs</a>',
    '<a href="/fixture-repo/docs/skills/alpha/">alpha</a>',
    '<a href="/fixture-repo/docs/skills/alpha/reference">reference</a>',
    '<a href="https://fixture-owner.github.io/other-repo/">sibling</a>',
    '<a href="/fixture-repo/docs/skills/missing/">gone</a>',
  ].join(" ");
  mkdirSync(join(repo, "dist", "assets"), { recursive: true });
  writeFileSync(
    join(repo, "dist", "index.html"),
    `<html><body>WEBSITE-ROOT ${links}</body></html>\n`,
  );
  writeFileSync(join(repo, "dist", "assets", "app.js"), "console.log(1)\n");
  writeFileSync(
    join(repo, "dist", "[guide].html"),
    '<a href="/fixture-repo/docs/skills/also-missing/">gone too</a>\n',
  );
}

function write(repo: string, rel: string, content: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), content);
}

/** One repository the way a fleet repository with the site module looks, at every ref a deploy reads:
 *
 *  v0.0.1  docs/ holds a listing and no landing page           -> skipped with a notice
 *  v0.1.0  the docs; a dead link sealed into setup.md;         -> lenient tier; the hand-written page serves at the
 *          docs/skills/README.md from before skills/ existed      mount's name, the missing root is a notice
 *  v0.2.0  the zh-cn locale, a favicon, skills/alpha;          -> the root and stable/ tiers
 *          the hand-written docs/skills/ page gone
 *  HEAD    the HEAD-only setup line, the ranked and grouped   -> latest/, the pages lychee judges
 *          pages, skills/beta and gamma with the skills
 *          landing, agents/one, the hook's dist */
export function fleetRepo(repo: string): void {
  write(repo, "docs/store-listing.md", "# Store listing\n\nBlurb.\n");
  initRepo(repo);
  commitAll(repo, "a docs listing before the landing page");
  fixtureGit(repo, ["tag", "v0.0.1"]);

  rmSync(join(repo, "docs", "store-listing.md"));
  write(repo, "docs/README.md", docsReadme(""));
  write(repo, "docs/setup.md", `${SETUP_MD}${SEALED_DEAD_LINK}`);
  write(repo, "docs/alerts.md", ALERTS_MD);
  write(repo, "docs/guide/README.md", "# Guide\n\nThe guide index, version one.\n");
  write(repo, "docs/skills/README.md", "# Skills, hand-written\n");
  commitAll(repo, "v1 docs");
  fixtureGit(repo, ["tag", "v0.1.0"]);

  rmSync(join(repo, "docs", "skills"), { recursive: true });
  write(repo, "docs/README.md", docsReadme(SKILL_LINKS_AT_TAG));
  write(repo, "docs/setup.md", SETUP_MD);
  write(repo, "docs/zh-cn/README.md", "# Fixture zh\n\nlocale landing page\n");
  write(repo, "docs/public/favicon.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  write(
    repo,
    "docs/guide/README.md",
    "# Guide\n\nThe guide index, version one.\nSecond version line.\n",
  );
  write(repo, "skills/alpha/SKILL.md", ALPHA_SKILL);
  write(repo, "skills/alpha/reference.md", "# Alpha reference\n\nDetails.\n");
  write(repo, "skills/alpha/.codex-plugin/plugin.json", "{}\n");
  commitAll(repo, "v2 docs, the locale, the favicon, and the alpha skill");
  fixtureGit(repo, ["tag", "v0.2.0"]);

  write(repo, "docs/README.md", docsReadme(SKILL_LINKS_AT_HEAD));
  write(repo, "docs/setup.md", `${SETUP_MD}HEAD-only line.\n`);
  write(repo, "docs/zulu.md", "---\norder: 1\ngroup: Basics\n---\n\n# Zulu\n\nRanked.\n");
  write(repo, "docs/delta.md", "---\ngroup: Basics\n---\n\n# Delta\n\nGrouped.\n");
  write(repo, "docs/bravo.md", "# Bravo\n\nUnplaced.\n");
  write(
    repo,
    "skills/alpha/SKILL.md",
    `${ALPHA_SKILL}\nSee the [one agent](../../agents/one/AGENT.md).\n`,
  );
  write(repo, "skills/beta/SKILL.md", BETA_SKILL);
  write(repo, "skills/gamma/SKILL.md", GAMMA_SKILL);
  write(
    repo,
    "skills/README.md",
    "# Skills\n\n| Skill | Purpose |\n|---|---|\n| [alpha](alpha/) | Alpha |\n| [beta](beta/) | Beta |\n",
  );
  write(repo, "agents/one/AGENT.md", ONE_AGENT);
  website(repo);
  commitAll(repo, "head docs, the skills landing, the agent, and the website");
}
