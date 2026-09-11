// Assembles the fleet's GitHub Pages site artifact (planning contract and
// layout in lib.ts; docs/site.md describes the result). Stateless by
// design: every deploy re-enumerates the version tags and rebuilds every
// docs tier, so theme updates restyle every version and nothing
// accumulates between runs.
//
// Entry modes (env, set by action.yml): CHECK=true builds docs/ once,
// strictly (dead internal links fatal), and emits no artifact; otherwise
// SITE_DIR (the site-build hook's dist, "" for none) and docs/ drive the
// layout and the publish and site-dir outputs. Both read CONFIG (the JSON
// the plan action or the caller resolved) and end in the internal-link
// gate (site_links.ts) over what they built. Both need a committed git
// checkout at GITHUB_WORKSPACE: each docs tier's project facts and commit
// are read from the ref's tree with git, never from the working files.
//
// Docs builds run against materialized trees so no node_modules bleeds
// across tiers: each tier COPIES its docs tree into the build root because
// module resolution walks up from the source files (buildVitepressTier).
// The website is copied as the hook built it.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectFacts } from "./facts.ts";
import {
  type DocsMount,
  type IncludeRoot,
  mountRel,
  parseSiteConfig,
  planMount,
  reservedRootEntries,
  type SiteConfig,
  siteLayout,
  type Tier,
  urlBase,
  validateRelPath,
  versionLinks,
  versionsIndex,
  versionTags,
} from "./lib.ts";
import { checkSiteLinks, type TierScope } from "./site_links.ts";

const ACTION_DIR = import.meta.dir;

/** The docs tree every repository renders: fixed, so the fleet's layout
 *  and PR check read one path (docs/site.md). */
export const DOCS_DIR = "docs";

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function requireEnv(name: string): string {
  const value = env(name);
  if (value === "") throw new Error(`${name} is required and empty`);
  return value;
}

/** Run argv, inheriting output; env additions land over the LIVE process
 *  env. Throws naming the argv on any nonzero exit. */
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

/** Whether `ref` carries `path`: `git ls-tree` separates the honest
 *  answers (exit 0 - entry listed or not) from failures (bad ref, corrupt
 *  repository), which throw via capture instead of collapsing into
 *  "absent" the way a plain exit-code probe would. */
function treeHas(cfg: Config, ref: string, path: string): boolean {
  return capture(["git", "-C", cfg.workspace, "ls-tree", ref, "--", path]).trim() !== "";
}

/** The file's content at `ref`, or null when the tree has no such path
 *  or the entry is not a regular file - `git show` on a SYMLINK yields
 *  its target path text, which must never be judged as content. Any
 *  other git failure still throws via capture. */
function treeFile(cfg: Config, ref: string, path: string): string | null {
  const entry = capture(["git", "-C", cfg.workspace, "ls-tree", ref, "--", path]).trim();
  if (entry === "") return null;
  const mode = entry.split(" ")[0];
  if (mode !== "100644" && mode !== "100755") return null;
  return capture(["git", "-C", cfg.workspace, "show", `${ref}:${path}`]);
}

/** A generated file the layout owns (versions.json, CNAME): never an
 *  overwrite - existing content at its path is a mount or build output
 *  claiming the same URL. */
function writeExclusive(path: string, content: string, what: string): void {
  if (existsSync(path)) {
    throw new Error(
      `${what} would overwrite existing site content at '${path}' - a mount or build ` +
        "output already claims that path; rename the colliding output",
    );
  }
  writeFileSync(path, content);
}

function setOutput(name: string, value: string): void {
  const out = env("GITHUB_OUTPUT");
  if (out === "") {
    console.log(`(output) ${name}=${value}`);
    return;
  }
  appendFileSync(out, `${name}=${value}\n`);
}

/** The docs landing page (docs/site.md, "Docs conventions"): README.md
 *  is the directory index the way GitHub renders it, and the fleet's
 *  sidebar and launcher key on it, so an index.md standing in for it is
 *  refused on the content being edited today (historical tags keep the
 *  index.html check alone). */
export function assertDocsLanding(docsTree: string): void {
  if (!existsSync(join(docsTree, "README.md"))) {
    throw new Error(
      `${DOCS_DIR}/README.md does not exist - it is the docs landing page; create it`,
    );
  }
}

/** The central-theme invariant: fleet repositories carry ONLY markdown, and
 *  the theme comes from repo-platform alone. A caller-shipped .vitepress
 *  directory would silently NOT apply (the build root is the action's, not
 *  the caller's), so it is refused loudly instead of shipping a site that
 *  ignores it. Historical tags carrying one are excluded from the version
 *  set instead (they cannot be fixed); this hard refusal covers the content
 *  being edited today. */
export function assertCentralTheme(docsTree: string): void {
  if (existsSync(join(docsTree, ".vitepress"))) {
    throw new Error(
      `${docsTree} contains a .vitepress directory, but the docs site's config and theme ` +
        "are central (repo-platform's actions/pages-site) - a repo-local .vitepress would " +
        "be silently ignored, so it is refused instead. Remove it from the docs tree; theme " +
        "changes belong in repo-platform.",
    );
  }
}

interface Config extends SiteConfig {
  workspace: string;
  scratch: string;
  site: string;
  /** The site-build hook's dist, relative to the repository root; "" for
   *  no website. */
  siteDir: string;
  maxVersions: number;
  customDomain: string;
  repository: string;
  /** GITHUB_SERVER_URL without a trailing slash: every link the build
   *  emits (edit links, project facts) joins onto it. */
  serverUrl: string;
  origin: string;
  rootBase: string;
  /** The repository's edit URL up to the repo root; a page's edit link
   *  appends its own source path (an include root's page edits at that
   *  root, not under the docs directory). */
  editBase: string;
  defaultBranch: string;
}

function readConfig(): Config {
  const workspace = requireEnv("GITHUB_WORKSPACE");
  const repository = requireEnv("GITHUB_REPOSITORY");
  const customDomain = env("CUSTOM_DOMAIN");
  const [owner, repo] = repository.split("/");
  const origin =
    customDomain !== "" ? `https://${customDomain}` : `https://${owner.toLowerCase()}.github.io`;
  const rootBase = customDomain !== "" ? "/" : `/${repo}/`;
  const maxVersionsRaw = env("MAX_VERSIONS", "5");
  if (!/^\d+$/.test(maxVersionsRaw) || Number(maxVersionsRaw) < 1) {
    throw new Error(`MAX_VERSIONS must be a positive integer (got '${maxVersionsRaw}')`);
  }
  const defaultBranch = env("DEFAULT_BRANCH", "main");
  const serverUrl = env("GITHUB_SERVER_URL", "https://github.com").replace(/\/+$/, "");
  // realpath'd: a scratch base behind a symlink (macOS /tmp) gives the
  // build two spellings of one directory, and path-keyed route resolution
  // inside vitepress falls apart on the mismatch.
  const scratch = join(realpathSync(env("RUNNER_TEMP", tmpdir())), "pages-site");
  return {
    ...parseSiteConfig(requireEnv("CONFIG")),
    workspace,
    scratch,
    site: join(scratch, "_site"),
    siteDir: env("SITE_DIR"),
    maxVersions: Number(maxVersionsRaw),
    customDomain,
    repository,
    serverUrl,
    origin,
    rootBase,
    defaultBranch,
    editBase: `${serverUrl}/${repository}/edit/${defaultBranch}/`,
  };
}

/** Extract `ref` (optionally one subtree) into a fresh directory; `git
 *  archive` never carries .git, so extracted builds cannot read history. */
function extractTree(cfg: Config, ref: string, into: string, subtree?: string): void {
  mkdirSync(into, { recursive: true });
  const tar = `${into}.tar`;
  run([
    "git",
    "-C",
    cfg.workspace,
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

/** A finished tier must serve its own base URL: a build that "succeeded"
 *  without an index.html deploys a 404 at the tier root on a green run
 *  (for the docs tree, that means no README.md or index.md landing page). */
function assertTierIndex(dist: string, what: string): string {
  if (!existsSync(join(dist, "index.html"))) {
    throw new Error(
      `${what} produced no index.html, so its own URL would 404 - give the build a ` +
        `landing page (for the docs tree: ${DOCS_DIR}/README.md)`,
    );
  }
  return dist;
}

/** The site-build hook's dist as the directory to copy to the site root,
 *  or the refusal the hook contract promises (docs/site.md): an absolute
 *  path or one leaving the repository would publish a tree that is not
 *  the judged commit's, a missing directory or one without index.html
 *  would deploy a 404 at the site root on a green run. Exported for its
 *  tests. */
export function resolvePrebuilt(workspace: string, dist: string): string {
  validateRelPath(dist, "the site-build hook's dist");
  const dir = join(workspace, dist);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(
      `the site-build hook named dist '${dist}', which is not a directory in the checkout - ` +
        "point dist at the directory the hook's build writes",
    );
  }
  return assertTierIndex(dir, `the site-build hook's dist '${dist}'`);
}

/** Dead-link strictness per tier: current content (a HEAD tier) must FAIL
 *  on a dead internal link - that failure is the docs PR check's value and
 *  the deploy's last line of defense - while historical tags build lenient
 *  because history cannot be fixed. Stubbing this to always-lenient would
 *  ship silently rotten current docs on a green run. */
export function tierStrictLinks(tier: Tier): boolean {
  return tier.ref === "HEAD";
}

/** Materialize each include root under `<srcDir>/<mount>/` the way the
 *  docs tree was (the workspace tree at HEAD, an extract at a tag) and
 *  return the roots this tier carries, in the order given. Shallower
 *  mounts stage first, so a root mounted inside another's mount
 *  (`skills/agents` under `skills`) lands in the parent's tree whichever
 *  order the caller listed them; a parent whose own source carries the
 *  child's directory is still the collision it is. At HEAD a missing root
 *  is a configuration error, like a missing docs directory; at a tag it
 *  is skipped with a notice, since history cannot be fixed. */
function stageIncludes(
  cfg: Config,
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
    if (tier.ref !== "HEAD" && !treeHas(cfg, tier.ref, include.path)) {
      console.log(
        `::notice::docs version ${tier.version} has no ${include.mount}/: ${include.path}/ does not exist at ${tier.ref}`,
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
      const tree = join(cfg.workspace, include.path);
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
      extractTree(cfg, tier.ref, staging, include.path);
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

/** A child directory carrying both the include's page and an index.md is
 *  refused: both would serve at the directory URL, and shipping one
 *  silently would hide the other. */
function assertIncludePages(target: string, include: IncludeRoot): void {
  for (const child of readdirSync(target, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    const dir = join(target, child.name);
    if (existsSync(join(dir, include.page)) && existsSync(join(dir, "index.md"))) {
      throw new Error(
        `${include.path}/${child.name}/ carries both ${include.page} and index.md - both would ` +
          `serve at ${include.mount}/${child.name}/; remove one`,
      );
    }
  }
}

/** One vitepress build: the bundled config and theme over the docs tree,
 *  materialized into the build root (HEAD tiers copy the workspace tree,
 *  tag tiers extract straight into the root), with the include roots
 *  staged inside it. Dead-link strictness is DERIVED here from the tier -
 *  the one owner - so a strict-HEAD build and a lenient-tag build are the
 *  only representable states. Project facts (facts.ts) read the tier's OWN
 *  ref, so a tagged version shows the toolchains and license that tag
 *  carried. */
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
  const srcDir = join(root, "docs");
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
    extractTree(cfg, tier.ref, staging, DOCS_DIR);
    renameSync(join(staging, DOCS_DIR), srcDir);
    rmSync(staging, { recursive: true, force: true });
    assertCentralTheme(srcDir);
  }
  const staged = stageIncludes(cfg, tier, root, srcDir, includes);
  // The action's own dependency set serves every build root: vitepress,
  // vue, and the llms plugin resolve through this link, so no build root
  // ever installs anything.
  symlinkSync(join(ACTION_DIR, "node_modules"), join(root, "node_modules"));
  const strictLinks = tierStrictLinks(tier);
  const sha = capture(["git", "-C", cfg.workspace, "rev-parse", `${tier.ref}^{commit}`]).trim();
  const facts = collectFacts((path) => treeFile(cfg, tier.ref, path), {
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
      DOCS_SITE_TITLE: siteTitle(cfg),
      DOCS_SITE_BASE: opts.base ?? urlBase(cfg.rootBase, tier.rel),
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

/** The title the docs build renders: the configured one, else the
 *  repository name. */
function siteTitle(cfg: Config): string {
  return cfg.siteTitle !== "" ? cfg.siteTitle : cfg.repository.split("/")[1];
}

/** Copy a build's entries into place, refusing overwrites: a collision is
 *  always two sources claiming one URL (the docs mount inside the
 *  website's output, a root build emitting a version directory's name),
 *  and shipping either silently would serve the wrong content on a green
 *  run. Exported for its tests. */
export function copyInto(src: string, dest: string, what: string, reserved?: Set<string>): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (reserved?.has(entry)) {
      throw new Error(
        `${what} emits a top-level '${entry}', which the versioned layout reserves ` +
          "(latest/, the version directories, versions.json) - rename that output",
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

/** The version tags the docs mount can serve: kept tags whose tree carries
 *  the docs directory and no repo-local .vitepress (history cannot be
 *  fixed, so ineligible tags are excluded with a notice instead of failing
 *  every deploy). */
function eligibleDocsTags(cfg: Config, kept: string[]): string[] {
  return kept.filter((tag) => {
    if (!treeHas(cfg, tag, DOCS_DIR)) {
      console.log(`::notice::docs version ${tag} skipped: ${DOCS_DIR}/ does not exist at that tag`);
      return false;
    }
    if (treeHas(cfg, tag, `${DOCS_DIR}/.vitepress`)) {
      console.log(
        `::notice::docs version ${tag} skipped: ${DOCS_DIR}/.vitepress exists at that tag ` +
          "(the theme is central; a repo-local one would be ignored)",
      );
      return false;
    }
    return true;
  });
}

/** Build and lay out the docs mount's tiers; returns each tier's place in
 *  the artifact and whether its content is current, for the link gate. */
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
    console.log(
      `::notice::no version tags to serve: ${mount.path} is built from the default branch head, like ${mount.path}latest/`,
    );
  }
  return tiers.map((tier) => ({ rel: tier.rel, strict: tierStrictLinks(tier) }));
}

/** The outputs every deploy run publishes, whatever it assembled. */
function setSiteOutputs(cfg: Config, site: string | null): void {
  setOutput("publish", site === null ? "false" : "true");
  setOutput("site-dir", site ?? "");
  setOutput("link-rot-label", cfg.linkRotLabel);
  setOutput("site-title", siteTitle(cfg));
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
    // The docs PR check: one strict build of the working tree (a HEAD tier
    // derives strict dead links) with the same include roots the deploy
    // stages, then the link gate over it; no artifact.
    const tier: Tier = { kind: "single", ref: "HEAD", version: "", rel: "" };
    const { dist } = buildVitepressTier(cfg, tier, [], cfg.include, { base: "/" });
    // No origin: this build sits at "/", not at the deployed layout, so a
    // link spelled with the site's own origin stays external here.
    const checked = await checkSiteLinks(dist, "/", [{ rel: "", strict: true }], null);
    console.log(
      `docs build check passed (${checked.judged} links judged across ${checked.pages} pages)`,
    );
    return;
  }

  const { docs, website } = siteLayout({
    dist: cfg.siteDir,
    hasDocs: existsSync(join(cfg.workspace, DOCS_DIR)),
    docsPath: cfg.docsPath,
    include: cfg.include,
  });
  if (docs === null && website === null) {
    console.log(
      `::notice::nothing to publish: the site-build hook named no directory and the repository has no ${DOCS_DIR}/`,
    );
    setSiteOutputs(cfg, null);
    return;
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
  ).slice(0, cfg.maxVersions);

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

  if (cfg.customDomain !== "") {
    writeExclusive(join(cfg.site, "CNAME"), `${cfg.customDomain}\n`, "the custom-domain CNAME");
  }
  // After every mount is in place: a link from one mount into another has
  // no other judge, and the artifact is handed back only when all resolve.
  const checked = await checkSiteLinks(cfg.site, cfg.rootBase, scopes, cfg.origin);
  console.log(
    `internal links resolve (${checked.judged} links judged across ${checked.pages} current pages)`,
  );
  setSiteOutputs(cfg, cfg.site);
  console.log(`assembled ${cfg.site}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
