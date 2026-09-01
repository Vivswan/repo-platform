// Assembles the fleet's versioned GitHub Pages site artifact (the planning
// contract and layout live in lib.ts; docs/pages.md and docs/docs-site.md
// document the result). Stateless by design: every deploy re-enumerates the
// repository's version tags and rebuilds every tier from scratch, so theme
// updates restyle every version on the next deploy and nothing accumulates
// between runs.
//
// Two entry modes (env, set by action.yml):
//   CHECK=true  build the caller's docs tree once, strictly (dead internal
//               links fatal), and stop - the docs PR check. No artifact.
//   otherwise   read MOUNTS, build every mount's tiers, lay out _site, and
//               emit the site-dir output for upload.
//
// Builds run against materialized trees (hermetic - no cross-tier
// node_modules or dist bleed): command tiers extract the whole ref with
// `git archive` because the caller's build command mutates its tree, and
// vitepress tiers copy the docs tree INTO the build root (a real copy;
// module resolution walks up from the source files, so anything outside
// the root misses the root's node_modules - see buildVitepressTier).

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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assemblyOrder,
  judgeCommandTag,
  type Mount,
  mountRel,
  parseCommandProbe,
  parseMounts,
  planMount,
  redirectHtml,
  reservedRootEntries,
  type Tier,
  urlBase,
  validateRelPath,
  versionLinks,
  versionsIndex,
  versionTags,
} from "./lib.ts";

const ACTION_DIR = import.meta.dir;

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
 *  its target path text, which must never be judged as content (a target
 *  spelled like valid JSON would judge the link instead of the file it
 *  reaches). Any other git failure still throws via capture. */
function treeFile(cfg: Config, ref: string, path: string): string | null {
  const entry = capture(["git", "-C", cfg.workspace, "ls-tree", ref, "--", path]).trim();
  if (entry === "") return null;
  const mode = entry.split(" ")[0];
  if (mode !== "100644" && mode !== "100755") return null;
  return capture(["git", "-C", cfg.workspace, "show", `${ref}:${path}`]);
}

/** Every path in `ref`'s tree. NUL-delimited on purpose: without -z git
 *  C-quotes non-ASCII paths, and a quoted package.json would vanish from
 *  the probe's candidate set. */
function listTree(cfg: Config, ref: string): string[] {
  return capture(["git", "-C", cfg.workspace, "ls-tree", "-r", "--name-only", "-z", ref])
    .split("\0")
    .filter((line) => line !== "");
}

/** A generated file the layout owns (versions.json, the redirect page,
 *  CNAME): never an overwrite - existing content at its path is a mount
 *  or build output claiming the same URL. */
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

interface Config {
  workspace: string;
  scratch: string;
  site: string;
  docsDir: string;
  siteTitle: string;
  installCommand: string;
  buildCommand: string;
  /** The job's PATH from before the action's pinned bun setup (recorded
   *  by action.yml's first step): caller-authored command-mount builds
   *  run with the toolchain the CALLER set up (reusable-pages pins it
   *  from the checkout's dotfiles), while the action's own code rides
   *  the action-local pin. Empty when the recording step is absent. */
  callerPath: string;
  distDir: string;
  maxVersions: number;
  customDomain: string;
  repository: string;
  origin: string;
  rootBase: string;
  editPattern: string;
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
  const docsDir = env("DOCS_DIR", "docs");
  validateRelPath(docsDir, "the docs directory");
  const defaultBranch = env("DEFAULT_BRANCH", "main");
  // realpath'd: a scratch base behind a symlink (macOS /tmp) gives the
  // build two spellings of one directory, and path-keyed route resolution
  // inside vitepress falls apart on the mismatch.
  const scratch = join(realpathSync(env("RUNNER_TEMP", tmpdir())), "pages-site");
  return {
    workspace,
    scratch,
    site: join(scratch, "_site"),
    docsDir,
    siteTitle: env("SITE_TITLE"),
    installCommand: env("INSTALL_COMMAND"),
    buildCommand: env("BUILD_COMMAND"),
    callerPath: env("CALLER_PATH"),
    distDir: env("DIST_DIR", "dist"),
    maxVersions: Number(maxVersionsRaw),
    customDomain,
    repository,
    origin,
    rootBase,
    editPattern: `${env("GITHUB_SERVER_URL", "https://github.com")}/${repository}/edit/${defaultBranch}/${docsDir}/:path`,
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
 *  (for a docs tree, that means no README.md or index.md landing page). */
function assertTierIndex(dist: string, what: string): string {
  if (!existsSync(join(dist, "index.html"))) {
    throw new Error(
      `${what} produced no index.html, so the tier's own URL would 404 - give the build a ` +
        "landing page (for a docs tree: docs/README.md)",
    );
  }
  return dist;
}

/** One command-mount build: the caller's install/build commands in an
 *  extracted tree, under the tier's PAGES_* contract. */
function buildCommandTier(cfg: Config, tier: Tier): { dist: string; buildDir: string } {
  const tree = join(cfg.scratch, `build-${buildCounter++}`);
  extractTree(cfg, tier.ref, tree);
  // A committed dist/ in the extracted tree could mask a build that wrote
  // nothing; the check below must only ever see this run's output.
  rmSync(join(tree, cfg.distDir), { recursive: true, force: true });
  const tierEnv = {
    PAGES_BASE_PATH: urlBase(cfg.rootBase, tier.rel),
    PAGES_ORIGIN: cfg.origin,
    PAGES_VERSION: tier.version,
    // The caller's pre-action PATH: the action's pinned bun governs only
    // action-owned code, never the caller's own build toolchain.
    ...(cfg.callerPath === "" ? {} : { PATH: cfg.callerPath }),
  };
  // The commands are caller-authored shell (the pages module's build
  // contract), so bash -c is the interface; everything else stays argv.
  // -e and pipefail, or a failed pipeline stage or non-final command
  // reads as success and deploys whatever half-built output exists.
  if (cfg.installCommand !== "")
    run(["bash", "-e", "-o", "pipefail", "-c", cfg.installCommand], { cwd: tree, env: tierEnv });
  run(["bash", "-e", "-o", "pipefail", "-c", cfg.buildCommand], { cwd: tree, env: tierEnv });
  const dist = join(tree, cfg.distDir);
  if (!existsSync(dist)) {
    throw new Error(
      `the build for ${tier.ref} did not create '${cfg.distDir}' - point dist_dir at the ` +
        "directory the build command writes, or fix the build command to produce it",
    );
  }
  return {
    dist: assertTierIndex(dist, `the ${tier.ref} build's '${cfg.distDir}'`),
    buildDir: tree,
  };
}

/** Dead-link strictness per tier: current content (a HEAD tier) must FAIL
 *  on a dead internal link - that failure is the docs PR check's value and
 *  the deploy's last line of defense - while historical tags build lenient
 *  because history cannot be fixed. Guard-registered: unarming this to
 *  always-lenient would ship silently rotten current docs on a green run. */
export function tierStrictLinks(tier: Tier): boolean {
  return tier.ref === "HEAD";
}

/** One vitepress build: the bundled config and theme over a caller docs
 *  tree, materialized into the build root (HEAD tiers copy the workspace
 *  tree, tag tiers extract straight into the root). Dead-link strictness
 *  is DERIVED here from the tier - the one owner - so a strict-HEAD build
 *  and a lenient-tag build are the only representable states. */
function buildVitepressTier(
  cfg: Config,
  tier: Tier,
  versions: { label: string; link: string }[],
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
    const docsTree = join(cfg.workspace, cfg.docsDir);
    if (!existsSync(docsTree)) {
      throw new Error(
        `${cfg.docsDir}/ does not exist in the repository - the docs site builds from that ` +
          "tree; create it (with a README.md index) or drop the docs-site module",
      );
    }
    assertCentralTheme(docsTree);
    cpSync(docsTree, srcDir, { recursive: true });
  } else {
    // Extract into a staging dir first: the archive lands at the caller's
    // full docs path (possibly nested, docs/api), and the leaf directory
    // then moves to the root's fixed docs/ slot whatever its depth was.
    const staging = join(root, ".src");
    extractTree(cfg, tier.ref, staging, cfg.docsDir);
    renameSync(join(staging, cfg.docsDir), srcDir);
    rmSync(staging, { recursive: true, force: true });
    assertCentralTheme(srcDir);
  }
  // The action's own dependency set serves every build root: vitepress,
  // vue, and the llms plugin resolve through this link, so no build root
  // ever installs anything.
  symlinkSync(join(ACTION_DIR, "node_modules"), join(root, "node_modules"));
  const strictLinks = tierStrictLinks(tier);
  run(["bun", join(ACTION_DIR, "node_modules", ".bin", "vitepress"), "build", root], {
    env: {
      DOCS_SITE_SRC: srcDir,
      DOCS_SITE_TITLE: cfg.siteTitle !== "" ? cfg.siteTitle : cfg.repository.split("/")[1],
      DOCS_SITE_BASE: opts.base ?? urlBase(cfg.rootBase, tier.rel),
      DOCS_SITE_VERSIONS: JSON.stringify(versions),
      DOCS_SITE_CURRENT: tier.version,
      DOCS_SITE_EDIT_PATTERN: fromWorkspace ? cfg.editPattern : "",
      DOCS_SITE_IGNORE_DEAD_LINKS: strictLinks ? "" : "1",
    },
  });
  return {
    dist: assertTierIndex(
      join(root, ".vitepress", "dist"),
      `the ${tier.ref} docs build (${cfg.docsDir}/)`,
    ),
    buildDir: root,
  };
}

/** Copy a build's entries into place, refusing overwrites: a collision is
 *  always two sources claiming one URL (a mount inside another mount's
 *  output, a root build emitting a version directory's name), and shipping
 *  either silently would serve the wrong content on a green run. Exported
 *  for its tests. */
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
          "(the docs_site_path answer) or drop the colliding build output",
      );
    }
    cpSync(join(src, entry), target, { recursive: true });
  }
}

/** The version tags a vitepress mount can serve: kept tags whose tree
 *  carries the docs directory and no repo-local .vitepress (history cannot
 *  be fixed, so ineligible tags are excluded with a notice instead of
 *  failing every deploy). */
function eligibleDocsTags(cfg: Config, kept: string[]): string[] {
  return kept.filter((tag) => {
    if (!treeHas(cfg, tag, cfg.docsDir)) {
      console.log(
        `::notice::docs version ${tag} skipped: ${cfg.docsDir}/ does not exist at that tag`,
      );
      return false;
    }
    if (treeHas(cfg, tag, `${cfg.docsDir}/.vitepress`)) {
      console.log(
        `::notice::docs version ${tag} skipped: ${cfg.docsDir}/.vitepress exists at that tag ` +
          "(the theme is central; a repo-local one would be ignored)",
      );
      return false;
    }
    return true;
  });
}

/** The version tags a command mount can serve: kept tags whose tree can
 *  structurally run the build command - for a probeable `bun run <script>`
 *  shape, some package.json the command can reach declares the script at
 *  that tag (lib.ts's judgeCommandTag carries the proof rules and
 *  the dependency-bin residual). A tag from before the site's build
 *  script existed is guaranteed unbuildable forever and would fail every
 *  deploy, so it is excluded with a notice (the vitepress mounts'
 *  missing-docs rule, mirrored); a tag that declares the script but whose
 *  build errors still fails the deploy loudly. An unprobeable command
 *  keeps every tag - only the shell can judge it. */
function eligibleCommandTags(cfg: Config, kept: string[]): string[] {
  if (kept.length === 0) return kept;
  const probe = parseCommandProbe(cfg.buildCommand);
  if (probe === null) return kept;
  const judgeAt = (ref: string) =>
    judgeCommandTag(
      probe,
      (path) => treeFile(cfg, ref, path),
      () => listTree(cfg, ref),
    );
  // Calibration: skipping is armed only by the AFFIRMATIVE verdict at
  // HEAD - a scripts entry there proves the command resolves through the
  // scripts table at all. A command that works some other way (a
  // dependency bin, a PATH executable, a file named like the script)
  // declares nothing at HEAD, and an inconclusive HEAD (a symlinked cwd,
  // an unparseable package.json) proves nothing either; both keep every
  // tag building. An install command that rewrites package.json at build
  // time stays the documented residual (the probe reads committed trees
  // only).
  if (judgeAt("HEAD").kind !== "declared") return kept;
  return kept.filter((tag) => {
    const verdict = judgeAt(tag);
    if (verdict.kind !== "skip") return true;
    console.log(`::notice::site version ${tag} skipped: ${verdict.reason}`);
    return false;
  });
}

function assembleMount(cfg: Config, mount: Mount, kept: string[]): void {
  // Eligibility only matters (and only prints its notices) where tags are
  // served; an unversioned mount builds HEAD alone.
  const tags = !mount.versioned
    ? []
    : mount.source === "vitepress"
      ? eligibleDocsTags(cfg, kept)
      : eligibleCommandTags(cfg, kept);
  const plan = planMount(mount, tags);
  const links = mount.versioned ? versionLinks(cfg.rootBase, mount, tags) : [];
  const mountRoot = join(cfg.site, mountRel(mount.path));
  const reserved = reservedRootEntries(tags);
  for (const tier of plan.tiers) {
    console.log(`building ${mount.source} tier '${tier.rel || "/"}' from ${tier.ref}`);
    const { dist, buildDir } =
      mount.source === "command"
        ? buildCommandTier(cfg, tier)
        : buildVitepressTier(cfg, tier, links);
    copyInto(
      dist,
      join(cfg.site, tier.rel),
      `mount '${mount.path}' tier '${tier.rel || "/"}' (${tier.ref})`,
      tier.kind === "root" ? reserved : undefined,
    );
    // The output is in the site now; keep the scratch footprint one tier
    // deep instead of N source trees plus N builds.
    rmSync(buildDir, { recursive: true, force: true });
  }
  if (mount.versioned) {
    writeExclusive(
      join(mountRoot, "versions.json"),
      `${JSON.stringify({ versions: versionsIndex(tags) }, null, 2)}\n`,
      `mount '${mount.path}' versions.json`,
    );
    if (plan.redirectToLatest) {
      writeExclusive(
        join(mountRoot, "index.html"),
        redirectHtml("./latest/"),
        `mount '${mount.path}' redirect page`,
      );
      console.log(
        `::notice::no version tags to serve: ${mount.path} redirects to ${mount.path}latest/`,
      );
    }
  }
}

function main(): void {
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
    // derives strict dead links), no artifact.
    const tier: Tier = { kind: "single", ref: "HEAD", version: "", rel: "" };
    buildVitepressTier(cfg, tier, [], { base: "/" });
    console.log("docs build check passed");
    return;
  }

  const mounts = parseMounts(requireEnv("MOUNTS"));
  if (mounts.some((m) => m.source === "command") && cfg.buildCommand === "") {
    throw new Error("a command mount is declared but the build command input is empty");
  }
  if (mounts.some((m) => m.source === "command")) {
    validateRelPath(cfg.distDir, "the dist directory");
  }
  // The control for the tag read below: a shallow checkout reads as "no
  // version tags" and would silently ship the redirect layout, so the
  // absence of tags is only believed from a full clone.
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
  for (const mount of assemblyOrder(mounts)) assembleMount(cfg, mount, kept);

  if (cfg.customDomain !== "") {
    writeExclusive(join(cfg.site, "CNAME"), `${cfg.customDomain}\n`, "the custom-domain CNAME");
  }
  setOutput("site-dir", cfg.site);
  console.log(`assembled ${cfg.site}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
