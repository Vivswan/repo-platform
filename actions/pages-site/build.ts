// Stateless by design: every deploy re-enumerates the version tags and rebuilds every docs tier.
// So theme updates restyle every version and nothing accumulates between runs.
// Any run that builds a docs tier needs a committed git checkout at GITHUB_WORKSPACE.
// The tier's project facts and commit are read from the ref's tree with git, never from the working files.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { error, notice, setOutput } from "@actions/core";
import { env } from "../shared/action_runtime.ts";
import { ownLinksPattern, pagesSite } from "../shared/pages_site.ts";
import { PLATFORM_NAME } from "../shared/platform.ts";
import { type IncludeRoot, isUnwalkedEntry, LANDING_FILES } from "./.vitepress/conventions.ts";
import { collectFacts } from "./facts.ts";
import {
  type DocsMount,
  mountRel,
  parseSiteConfig,
  planMount,
  reservedRootEntries,
  type SiteConfig,
  seedPages,
  siteLayout,
  type Tier,
  type TierScope,
  urlBase,
  validateRelPath,
  versionLinks,
  versionsIndex,
  versionTags,
} from "./lib.ts";

/** The action's own directory: every build root gets its `.vitepress/` copied and its `node_modules` linked from here. */
const ACTION_DIR = import.meta.dir;

/** The docs tree every repository renders: fixed, so the fleet's layout and PR check read one path (docs/modules/site.md). */
export const DOCS_DIR = "docs";

/** Newest version tags a docs mount serves (docs/modules/site.md, "Versions"). */
const MAX_VERSIONS = 5;

function requireEnv(name: string): string {
  const value = env(name);
  if (value === "") throw new Error(`${name} is required and empty`);

  return value;
}

function run(argv: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): void {
  const proc = spawnSync(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    stdio: "inherit",
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  if (proc.error) throw proc.error;

  if (proc.status !== 0) {
    throw new Error(`command failed (exit ${proc.status}): ${argv.join(" ")}`);
  }
}

function capture(argv: string[], cwd?: string): string {
  const proc = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf-8" });
  if (proc.error) throw proc.error;

  if (proc.status !== 0) {
    throw new Error(`command failed (exit ${proc.status}): ${argv.join(" ")}\n${proc.stderr}`);
  }

  return proc.stdout;
}

/** `git ls-tree` separates the honest answers (exit 0, entry listed or not) from failures (bad ref, corrupt repository).
 *  A failure throws via capture instead of collapsing into absent. */
function treeHas(workspace: string, ref: string, path: string): boolean {
  return capture(["git", "-C", workspace, "ls-tree", ref, "--", path]).trim() !== "";
}

/** `git show` on a symlink yields its target path text, which must never be judged as content. */
function treeFile(workspace: string, ref: string, path: string): string | null {
  const entry = capture(["git", "-C", workspace, "ls-tree", ref, "--", path]).trim();
  if (entry === "") return null;

  const mode = entry.split(" ")[0];
  if (mode !== "100644" && mode !== "100755") return null;

  return capture(["git", "-C", workspace, "show", `${ref}:${path}`]);
}

function writeExclusive(path: string, content: string, what: string): void {
  if (existsSync(path)) {
    throw new Error(
      `${what} would overwrite existing site content at '${path}' - a mount or build ` +
        "output already claims that path; rename the colliding output",
    );
  }
  writeFileSync(path, content);
}

/** The docs landing page (docs/modules/site.md, "Docs conventions"): README.md
 *  is the directory index the way GitHub renders it, so an index.md standing
 *  in for it is refused on the content being edited today (historical tags
 *  keep the index.html check alone). */
export function assertDocsLanding(docsTree: string): void {
  if (!existsSync(join(docsTree, "README.md"))) {
    throw new Error(
      `${DOCS_DIR}/README.md does not exist - it is the docs landing page; create it`,
    );
  }
}

/** Historical tags carrying one are excluded from the version set instead (eligibleDocsTags); this refusal covers the content being edited today. */
export function assertCentralTheme(docsTree: string): void {
  if (existsSync(join(docsTree, ".vitepress"))) {
    throw new Error(
      `${docsTree} contains a .vitepress directory, but the docs site's config and theme ` +
        `are central (${PLATFORM_NAME}'s actions/pages-site) - a repo-local .vitepress would ` +
        "be silently ignored, so it is refused instead. Remove it from the docs tree; theme " +
        `changes belong in ${PLATFORM_NAME}.`,
    );
  }
}

interface Config extends SiteConfig {
  /** GITHUB_WORKSPACE: the checkout every tier is extracted from. */
  workspace: string;

  /** The run's scratch directory under RUNNER_TEMP, realpath'd, where every build root and the artifact sit. */
  scratch: string;

  /** The directory the artifact sits in at its base path, the way Pages serves it: lychee's --root-dir, so an absolute link resolves as the browser resolves it. */
  served: string;

  /** The artifact's own directory: `served` at the base path, so `served` itself for a user site. */
  site: string;

  /** The site-build hook's dist, relative to the repository root; "" for no website. */
  siteDir: string;

  /** owner/name, as GITHUB_REPOSITORY spells it. */
  repository: string;

  /** GITHUB_SERVER_URL without a trailing slash: every link the build emits (edit links, project facts) joins onto it. */
  serverUrl: string;

  /** The Pages origin the site is served from. */
  origin: string;

  /** The URL path the site is served under (pagesSite's base path). */
  rootBase: string;

  /** The repository's edit URL up to the repo root; a page's edit link appends its own source path (an include root's page edits at that root, not under the docs directory). */
  editBase: string;

  /** DEFAULT_BRANCH, else `main`: the edit links' branch, and the provenance label of a tier built from HEAD. */
  defaultBranch: string;
}

function readConfig(): Config {
  const workspace = requireEnv("GITHUB_WORKSPACE");
  const repository = requireEnv("GITHUB_REPOSITORY");
  const { origin, basePath: rootBase } = pagesSite(repository);
  const defaultBranch = env("DEFAULT_BRANCH", "main");
  const serverUrl = env("GITHUB_SERVER_URL", "https://github.com").replace(/\/+$/, "");
  // realpath'd: a scratch base behind a symlink (macOS /tmp) gives the
  // build two spellings of one directory, and path-keyed route resolution
  // inside vitepress falls apart on the mismatch.
  const scratch = join(realpathSync(requireEnv("RUNNER_TEMP")), "pages-site");
  const served = join(scratch, "served");
  return {
    ...parseSiteConfig(requireEnv("CONFIG")),
    workspace,
    scratch,
    served,
    site: join(served, rootBase.slice(1, -1)),
    siteDir: env("SITE_DIR"),
    repository,
    serverUrl,
    origin,
    rootBase,
    defaultBranch,
    editBase: `${serverUrl}/${repository}/edit/${defaultBranch}/`,
  };
}

/** `git archive` never carries .git, so extracted builds cannot read history. */
function extractTree(workspace: string, ref: string, into: string, subtree?: string): void {
  mkdirSync(into, { recursive: true });
  const tar = `${into}.tar`;
  run([
    "git",
    "-C",
    workspace,
    "archive",
    "--format=tar",
    "-o",
    tar,
    ref,
    ...(subtree === undefined ? [] : ["--", subtree]),
  ]);
  run(["tar", "-xf", tar, "-C", into]);
  rmSync(tar);
}

let buildCounter = 0;

function assertTierIndex(dist: string, what: string): string {
  if (!existsSync(join(dist, "index.html"))) {
    throw new Error(
      `${what} produced no index.html, so its own URL would 404 - give the build a ` +
        `landing page (for the docs tree: ${DOCS_DIR}/README.md)`,
    );
  }

  return dist;
}

/** Exported for its tests. */
export function resolvePrebuilt(workspace: string, dist: string): string {
  validateRelPath(dist, "the site-build hook's dist");
  const dir = join(workspace, dist);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(
      `the site-build hook named dist '${dist}', which is not a directory in the checkout - ` +
        "point dist at the directory the hook's build writes",
    );
  }
  // A symlink at a lexically valid path can point anywhere on disk.
  const root = realpathSync(workspace);
  const real = realpathSync(dir);
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error(
      `the site-build hook named dist '${dist}', which resolves to '${real}' outside the ` +
        "checkout - point dist at a directory inside the repository",
    );
  }

  return assertTierIndex(dir, `the site-build hook's dist '${dist}'`);
}

/** Current content must fail on a dead internal link; historical tags build lenient because history cannot be fixed.
 *  Always-lenient would ship silently rotten current docs on a green run. */
export function tierStrictLinks(tier: Tier): boolean {
  return tier.ref === "HEAD";
}

/** Shallower mounts stage first.
 *  So a root mounted inside another's mount (`skills/agents` under `skills`) lands in the parent's tree whichever order the caller listed them.
 *  At a tag a missing root is skipped with a notice, since history cannot be fixed. Exported for its tests. */
export function stageIncludes(
  workspace: string,
  tier: Tier,
  root: string,
  srcDir: string,
  includes: readonly IncludeRoot[],
): IncludeRoot[] {
  const staged = new Set<IncludeRoot>();
  const depth = (include: IncludeRoot) => include.mount.split("/").length;
  for (const include of [...includes].sort((a, b) => depth(a) - depth(b))) {
    // The tag's own tree decides first: a tag from before the root existed
    // is skipped whatever its docs tree carries at the mount's name.
    if (tier.ref !== "HEAD" && !treeHas(workspace, tier.ref, include.path)) {
      notice(
        `docs version ${tier.version} has no ${include.mount}/: ${include.path}/ does not exist at ${tier.ref}`,
      );
      continue;
    }

    const target = join(srcDir, include.mount);
    if (existsSync(target)) {
      throw new Error(
        `the include root '${include.path}' mounts at '${include.mount}/', which the docs tree ` +
          `(${DOCS_DIR}/, or a root mounted above it) already carries at ${tier.ref} - two ` +
          "sources would claim one URL; mount the root under another name",
      );
    }

    if (tier.ref === "HEAD") {
      const tree = join(workspace, include.path);
      if (!existsSync(tree)) {
        throw new Error(
          `${include.path}/ does not exist in the repository - the docs site includes it at ` +
            `${include.mount}/; create it or drop the include`,
        );
      }
      mkdirSync(dirname(target), { recursive: true });
      cpSync(tree, target, { recursive: true });
    } else {
      const staging = join(root, ".src");
      extractTree(workspace, tier.ref, staging, include.path);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(join(staging, include.path), target);
      rmSync(staging, { recursive: true, force: true });
    }

    if (!statSync(target).isDirectory()) {
      throw new Error(
        `the include root '${include.path}' is a file, not a directory, at ${tier.ref}`,
      );
    }
    assertIncludePages(target, include);
    staged.add(include);
  }

  return includes.filter((include) => staged.has(include));
}

export function assertIncludePages(target: string, include: IncludeRoot): void {
  for (const child of readdirSync(target, { withFileTypes: true })) {
    if (!child.isDirectory() || isUnwalkedEntry(child.name)) continue;

    const dir = join(target, child.name);
    if (existsSync(join(dir, include.page)) && existsSync(join(dir, "index.md"))) {
      throw new Error(
        `${include.path}/${child.name}/ carries both ${include.page} and index.md - both would ` +
          `serve at ${include.mount}/${child.name}/; remove one`,
      );
    }
  }
}

/** Dead-link strictness is derived here from the tier, the one owner.
 *  So a strict HEAD build and a lenient tag build are the only representable states.
 *  Project facts read the tier's own ref, so a tagged version shows the toolchains and license that tag carried. */
function buildVitepressTier(
  cfg: Config,
  tier: Tier,
  versions: { label: string; link: string }[],
  includes: readonly IncludeRoot[],
  opts: { base?: string } = {},
): { dist: string; buildDir: string } {
  const fromWorkspace = tier.ref === "HEAD";
  const root = join(cfg.scratch, `build-${buildCounter++}`);
  mkdirSync(root, { recursive: true });
  cpSync(join(ACTION_DIR, ".vitepress"), join(root, ".vitepress"), { recursive: true });
  // The docs tree is MATERIALIZED inside the build root as a real copy:
  // module resolution for the pages' own SSR imports (vue/server-renderer)
  // walks up from the source files, so a srcDir outside the root (the
  // workspace checkout, an extract dir) never reaches the root's
  // node_modules on the real runner layout, and a symlinked tree resolves
  // to its realpath and breaks the same way.
  const srcDir = join(root, DOCS_DIR);
  if (fromWorkspace) {
    const docsTree = join(cfg.workspace, DOCS_DIR);
    if (!existsSync(docsTree)) {
      throw new Error(
        `${DOCS_DIR}/ does not exist in the repository - the docs site builds from that ` +
          "tree; create it (with a README.md index)",
      );
    }
    assertDocsLanding(docsTree);
    assertCentralTheme(docsTree);
    cpSync(docsTree, srcDir, { recursive: true });
  } else {
    // Extract into a staging dir first so the tree's leaf directory moves
    // to the root's fixed docs/ slot.
    const staging = join(root, ".src");
    extractTree(cfg.workspace, tier.ref, staging, DOCS_DIR);
    renameSync(join(staging, DOCS_DIR), srcDir);
    rmSync(staging, { recursive: true, force: true });
    assertCentralTheme(srcDir);
  }

  const staged = stageIncludes(cfg.workspace, tier, root, srcDir, includes);
  // The action's own dependency set serves every build root: vitepress,
  // vue, and the llms plugin resolve through this link, so no build root
  // ever installs anything.
  symlinkSync(join(ACTION_DIR, "node_modules"), join(root, "node_modules"));
  const strictLinks = tierStrictLinks(tier);
  const sha = capture(["git", "-C", cfg.workspace, "rev-parse", `${tier.ref}^{commit}`]).trim();
  const facts = collectFacts((path) => treeFile(cfg.workspace, tier.ref, path), {
    repository: cfg.repository,
    docsDir: DOCS_DIR,
    defaultBranch: cfg.defaultBranch,
    ref: tier.ref,
    sha,
    serverUrl: cfg.serverUrl,
  });
  // The action's own bun (the one running this script), never `bun` off
  // PATH: the hook's toolchain setup may have put the repository's bun first.
  run([process.execPath, join(ACTION_DIR, "node_modules", ".bin", "vitepress"), "build", root], {
    env: {
      DOCS_SITE_SRC: srcDir,
      DOCS_SITE_TITLE: cfg.siteTitle,
      DOCS_SITE_BASE: opts.base ?? urlBase(cfg.rootBase, tier.rel),
      DOCS_SITE_ORIGIN: cfg.origin,
      DOCS_SITE_VERSIONS: JSON.stringify(versions),
      DOCS_SITE_CURRENT: tier.version,
      DOCS_SITE_INCLUDES: JSON.stringify(staged),
      DOCS_SITE_EDIT_BASE: fromWorkspace ? cfg.editBase : "",
      DOCS_SITE_IGNORE_DEAD_LINKS: strictLinks ? "" : "1",
      DOCS_SITE_FACTS: JSON.stringify(facts),
    },
  });
  return {
    dist: assertTierIndex(
      join(root, ".vitepress", "dist"),
      `the ${tier.ref} docs build (${DOCS_DIR}/)`,
    ),
    buildDir: root,
  };
}

/** Exported for its tests. */
export function copyInto(src: string, dest: string, what: string, reserved?: Set<string>): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (reserved?.has(entry)) {
      throw new Error(
        `${what} emits a top-level '${entry}', which the versioned layout reserves ` +
          "(latest/, stable/, the version directories, versions.json) - rename that output",
      );
    }

    const target = join(dest, entry);
    if (existsSync(target)) {
      throw new Error(
        `${what} collides with existing site content at '${target}' - two mounts (or a ` +
          "mount and a build output) claim the same path; rename the docs mount " +
          "(the registration's site.path) or drop the colliding build output",
      );
    }
    cpSync(join(src, entry), target, { recursive: true });
  }
}

/** The version tags the docs mount can serve. History cannot be fixed, so
 *  a tag the build would refuse is excluded with a notice instead of
 *  failing every deploy; a docs tree without a landing page is one (the
 *  llms.txt plugin fails the build without an index page). */
function eligibleDocsTags(cfg: Config, kept: string[]): string[] {
  const skip = (tag: string, why: string) => {
    notice(`docs version ${tag} skipped: ${why} at that tag`);
    return false;
  };
  return kept.filter((tag) => {
    if (!treeHas(cfg.workspace, tag, DOCS_DIR)) return skip(tag, `${DOCS_DIR}/ does not exist`);

    if (treeHas(cfg.workspace, tag, `${DOCS_DIR}/.vitepress`)) {
      return skip(
        tag,
        `${DOCS_DIR}/.vitepress exists (the theme is central; a repo-local one would be ignored)`,
      );
    }

    if (![...LANDING_FILES].some((name) => treeHas(cfg.workspace, tag, `${DOCS_DIR}/${name}`))) {
      return skip(tag, `${DOCS_DIR}/ has no landing page (${[...LANDING_FILES].join(" or ")})`);
    }

    return true;
  });
}

function assembleDocs(cfg: Config, mount: DocsMount, kept: string[]): TierScope[] {
  const tags = eligibleDocsTags(cfg, kept);
  const tiers = planMount(mount, tags);
  const links = versionLinks(cfg.rootBase, mount, tags);
  const mountRoot = join(cfg.site, mountRel(mount.path));
  const reserved = reservedRootEntries(tags);
  for (const tier of tiers) {
    console.log(`building docs tier '${tier.rel || "/"}' from ${tier.ref}`);
    const { dist, buildDir } = buildVitepressTier(cfg, tier, links, mount.include);
    copyInto(
      dist,
      join(cfg.site, tier.rel),
      `the docs mount '${mount.path}' tier '${tier.rel || "/"}' (${tier.ref})`,
      tier.kind === "root" ? reserved : undefined,
    );
    // The output is in the site now; keep the scratch footprint one tier
    // deep instead of N source trees plus N builds.
    rmSync(buildDir, { recursive: true, force: true });
  }
  writeExclusive(
    join(mountRoot, "versions.json"),
    `${JSON.stringify({ versions: versionsIndex(tags) }, null, 2)}\n`,
    `the docs mount '${mount.path}' versions.json`,
  );
  if (tags.length === 0) {
    notice(
      `no version tags to serve: ${mount.path} is built from the default branch head, like ${mount.path}latest/, and ${mount.path}stable/ is absent`,
    );
  }

  return tiers.map((tier) => ({ rel: tier.rel, strict: tierStrictLinks(tier) }));
}

/** Pages serves `.htm` as well as `.html`. */
function walkHtml(dir: string, prefix = ""): string[] {
  const pages: string[] = [];
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    if (statSync(join(dir, rel)).isDirectory()) {
      pages.push(...walkHtml(dir, rel));
    } else if (/\.html?$/i.test(name)) {
      pages.push(rel);
    }
  }

  return pages;
}

/** What the artifact owns on its origin: its top-level entries, an html page under its extensionless name too (Pages
 *  serves both). */
export function ownEntries(site: string): string[] {
  const names = new Set<string>();
  for (const name of readdirSync(site)) {
    names.add(name);
    const page = /\.html?$/i.test(name) && statSync(join(site, name)).isFile();
    if (page) names.add(name.replace(/\.html?$/i, ""));
  }

  return [...names].sort();
}

/** The arguments the action's link-check step (action.yml) hands lychee on top of its own: the pages built from HEAD as
 *  the inputs, resolved under the served root. The own-links remap is not among them: it is the scratch directory's
 *  lychee.toml (writeLinkCheckConfig), which the docs PR check never writes, so there a link spelled with the site's URL
 *  stays external. */
function linkCheckArgs(
  cfg: Config,
  layout: { served: string; site: string; tiers: TierScope[] },
): string {
  const pages = seedPages(walkHtml(layout.site), layout.tiers);
  if (pages.length === 0) {
    throw new Error(
      `${layout.site} holds no page built from HEAD - the layout always has one, so nothing would be checked`,
    );
  }
  // lychee reads an input carrying [, ], * or ? as a glob, so such a page is spelled as the pattern matching it alone.
  const literal = (path: string) => path.replace(/[[\]*?]/g, "[$&]");
  const inputs = join(cfg.scratch, "link-check-inputs.txt");
  writeFileSync(inputs, `${pages.map((page) => literal(join(layout.site, page))).join("\n")}\n`);
  // Each value is quoted for lychee-action, which evals its args in bash.
  return [`--root-dir ${Bun.$.escape(layout.served)}`, `--files-from ${Bun.$.escape(inputs)}`].join(
    " ",
  );
}

/** The link check's lychee.toml, read from its working directory, the scratch (action.yml): a link matching `ownLinks`
 *  is remapped into the artifact, the pattern's capture (the tail after the base) carried into the file URL. A file
 *  rather than an argument: the regex grows with the artifact's top-level entries, and one argument string is capped
 *  at 128 KiB on Linux. */
function writeLinkCheckConfig(cfg: Config, site: string, ownLinks: string): void {
  const remap = `${ownLinks} ${Bun.pathToFileURL(site).href}$1`;
  writeFileSync(join(cfg.scratch, "lychee.toml"), Bun.TOML.stringify({ remap: [remap] }));
}

/** The nightly link-rot crawl's .lycheeignore, staged into the site after the upload (reusable-site.yml): the own links
 *  the assembly judged, then the repository's own list when it has one. Returns the file's path, the deploy's
 *  `link-rot-ignore` output. */
function writeLinkRotIgnore(cfg: Config, ownLinks: string): string {
  const repository = join(cfg.workspace, ".lycheeignore");
  const own = existsSync(repository) ? readFileSync(repository, "utf-8") : "";
  const path = join(cfg.scratch, "link-rot.lycheeignore");
  writeFileSync(path, `${ownLinks}\n${own}`);
  return path;
}

/** The outputs every deploy run publishes, whatever it assembled. `linkRotIgnore` is the path of the nightly crawl's
 *  .lycheeignore, "" with nothing to publish. */
function setSiteOutputs(
  cfg: Config,
  site: string | null,
  linkCheck: string,
  linkRotIgnore: string,
): void {
  setOutput("publish", site === null ? "false" : "true");
  setOutput("site-dir", site ?? "");
  setOutput("link-check-args", linkCheck);
  setOutput("link-rot-ignore", linkRotIgnore);
  setOutput("link-rot-label", cfg.linkRotLabel);
  setOutput("link-rot-color", cfg.linkRotColor);
  setOutput("link-rot-description", cfg.linkRotDescription);
  setOutput("site-title", cfg.siteTitle);
}

async function main(): Promise<void> {
  const cfg = readConfig();
  rmSync(cfg.scratch, { recursive: true, force: true });
  mkdirSync(cfg.scratch, { recursive: true });

  // Parsed at the boundary: anything but the two honest spellings is a
  // wiring mistake, never a silent deploy.
  const check = env("CHECK", "false");
  if (check !== "true" && check !== "false" && check !== "") {
    throw new Error(`CHECK must be "true" or "false" (got '${check}')`);
  }

  if (check === "true") {
    if (cfg.docs === null) {
      notice("docs-check stood down: the registration turns the docs half off (site.path: null)");
      return;
    }

    const tier: Tier = { kind: "single", ref: "HEAD", version: "", rel: "" };
    const { dist } = buildVitepressTier(cfg, tier, [], cfg.docs.include, { base: "/" });
    // No remap: this build sits at "/", not at the deployed layout, so a
    // link spelled with the site's own origin stays external here.
    const tiers = [{ rel: "", strict: true }];
    setOutput("link-check-args", linkCheckArgs(cfg, { served: dist, site: dist, tiers }));
    return;
  }

  const { docs, website } = siteLayout({
    dist: cfg.siteDir,
    hasDocs: existsSync(join(cfg.workspace, DOCS_DIR)),
    docs: cfg.docs,
  });
  if (docs === null && website === null) {
    const why =
      cfg.docs === null
        ? "the docs half is off (site.path: null)"
        : `the repository has no ${DOCS_DIR}/`;
    notice(`nothing to publish: the site-build hook named no directory and ${why}`);
    setSiteOutputs(cfg, null, "", "");
    return;
  }

  if (website === null) {
    notice(
      `no repository website (no site-build dist directory was handed over), so ${DOCS_DIR}/ publishes alone`,
    );
  }
  // The hook's dist is judged before any docs tier builds: a refused
  // website fails in seconds, not after the versions rendered.
  const websiteDir = website === null ? null : resolvePrebuilt(cfg.workspace, website.dist);
  // The control for the tag read below: a shallow checkout reads as "no
  // version tags" and would silently serve HEAD at the root with every
  // version dropped, so the absence of tags is only believed from a full
  // clone.
  if (
    capture(["git", "-C", cfg.workspace, "rev-parse", "--is-shallow-repository"]).trim() !== "false"
  ) {
    throw new Error(
      "the checkout is shallow - version tags and per-ref trees come from history, so the " +
        "calling workflow must check out with fetch-depth: 0",
    );
  }

  const kept = versionTags(
    capture(["git", "-C", cfg.workspace, "tag", "--list", "v*"]).split("\n"),
  ).slice(0, MAX_VERSIONS);

  mkdirSync(cfg.site, { recursive: true });
  const scopes: TierScope[] = [];
  // The docs land first: the website's copy then meets the docs mount's
  // directory already in place, so a website emitting that directory
  // collides loudly instead of silently mixing two sources under one URL.
  if (docs !== null) scopes.push(...assembleDocs(cfg, docs, kept));

  if (website !== null && websiteDir !== null) {
    console.log(`copying the site-build hook's website from ${website.dist}`);
    copyInto(websiteDir, cfg.site, `the site-build hook's website ('${website.dist}')`);
    scopes.push({ rel: "", strict: true });
  }

  // After every mount is in place: a link from one mount into another has
  // no other judge than the check over the whole artifact.
  const { served, site, rootBase, origin } = cfg;
  const ownLinks = ownLinksPattern({ origin, basePath: rootBase }, ownEntries(site));
  writeLinkCheckConfig(cfg, site, ownLinks);
  const linkCheck = linkCheckArgs(cfg, { served, site, tiers: scopes });
  setSiteOutputs(cfg, site, linkCheck, writeLinkRotIgnore(cfg, ownLinks));
  console.log(`assembled ${cfg.site}`);
}

if (import.meta.main) {
  main().catch((err) => {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
