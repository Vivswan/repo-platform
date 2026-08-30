#!/usr/bin/env bun
// Validate a repo generated/managed by Vivswan/repo-platform.
//
// Checks (errors fail the run):
//   1. .copier-answers.yml and .repo-platform.yml exist, the latter records
//      a valid top-level `modules` list, and the former pins a well-formed
//      `github_username` (the owner whose composite actions ci.yml must use)
//   2. .gitignore managed/local marker sections appear exactly once, in
//      their declared order
//   3. Every .yml/.yaml file parses; duplicate mapping keys are errors
//      under .github/ and in the registration files, advisories elsewhere
//   4. No unresolved merge-conflict markers in text files
//   5. .github/workflows/ci.yml exists (the template always generates and
//      manages it) and the all-green gate is wired for the tree's shape.
//      Verdict shape (no `all-green` job in ci.yml): the required check is
//      a check run a workflow_run-triggered verdict workflow creates, so
//      .github/workflows/all-green.yml must exist, fire on CI completions,
//      carry the workflow_dispatch `sha` unwedge input, and call the
//      reusable-all-green.yml judgment - and on client renders ci.yml must
//      carry an UNCONDITIONAL job calling repo-platform's fleet-ci.yml
//      reusable (the verdict judges only jobs that ran, so a deleted or
//      conditioned-away caller would pass with every fleet gate dropped).
//      Legacy shape (an `all-green` job
//      still present): the job carries `if: always()`, a step failing on
//      any non-success result, and `needs:` listing every other job, and
//      the typography check renders for the visibility: a `typography`
//      job on public renders, an unconditional check-typography step inside
//      `base-checks` on private renders (which merge the base checks there)
//   6. LICENSE and LICENSE.md never coexist - a repo carries exactly one
//      license file
//   7. Every selected toolchain module with a version pin carries its
//      managed version dotfile with exactly the pinned version
//   8. Sync-managed files self-declare their ownership: files sync wholly
//      overwrites open with the managed header naming the pinned owner, and
//      split files (a managed top above a repo-owned tail) carry their
//      declared split marker line exactly once. Existing files
//      only - absence is damage the next sync heals - and _skip_if_exists
//      starters are exempt (repo-owned after the first render)
//   9. Ownership-manifest byte parity: .github/repo-platform-manifest.json
//      (the template-rendered ownership map, hashes and the render's _commit
//      provenance stamped post-render by the template's stamp_manifest.ts
//      hook) is well-formed, its own entry stays hash-null (a self-hash
//      would be circular - the content includes every other hash), its
//      class metadata agrees with this validator's own ownership tables
//      for every path they cover (sync baselines local manifest edits, so
//      a hand-flipped class would otherwise disable parity permanently),
//      and every managed or split entry's recorded sha256 matches the file
//      on disk (split files: the managed half alone, delimited by the
//      entry's marker line). Drift means the file changed since the last
//      stamp; the next sync replaces it. Validation is STRICT: every build
//      ships the manifest, so a missing manifest, a provenance stamp that
//      differs from the recorded _commit (null included - the stamper
//      always writes the recorded value), and a missing roster entry whose
//      file still exists are hard errors. A listed file missing from the
//      repo stays an advisory (check 8's absence stance - the
//      withheld-workflows push path leaves those legitimately); a
//      conflict-marked manifest is left to check 4's report.
//
// Advisories (printed, never fail): missing actionlint / yamllint /
// commit-names / gitleaks checks in ci.yml (older renders predate the newer
// checks) - matched as jobs on public renders and as base-checks steps on
// private ones - plus dependency-review on public renders only (private
// renders never get that job, so their answers silence the advisory);
// duplicate mapping keys in YAML outside .github/ and the registration
// files; a bun-module repo whose package.json still carries packageManager
// (redundant once .bun-version pins the toolchain).
//
// Usage: bun actions/validate-template/validate_generated_files.ts [--self] [target-dir]
//
// --self: validate repo-platform itself. Skips the registration-file check
// (the template repo is not generated from itself, so it has no
// .copier-answers.yml / .repo-platform.yml), and skips gitignored paths in
// the per-file walk: the operator checkout carries gitignored working
// state (agent worktrees with in-progress rebases, the composed template/
// output) that is not the repository's content. Client renders keep the
// full walk - they are validated as plain trees, often before any git
// init, and everything in them is content. All other checks apply, except
// that check 9 inverts: the ownership manifest lands only in generated
// repos (this repo dogfoods individual template twins via
// scripts/render_dogfood.ts instead of rendering itself), so in self mode
// a PRESENT manifest is the error.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { parseAllDocuments, parse as parseYaml } from "yaml";
import { GRAMMAR, HEADER_WINDOW, knownGrammar, type RegionSplit } from "../shared/grammar.ts";
import { MANIFEST_NAME, type ManifestEntryShape, parseManifestFiles } from "../shared/manifest.ts";
import { managedHalf } from "../shared/stamp_manifest.ts";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "dist",
  "build",
  "coverage",
  "htmlcov",
  "__pycache__",
  ".output",
  ".wxt",
  ".astro",
  ".next",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
]);

/** The verdict's anchor job as the judged run names it: the managed
 *  ci.yml's `ci` caller prefixing fleet-ci's unconditional
 *  validate-template job. The managed all-green.yml wrapper must pass it
 *  as require-job (check 5) - the reusable verdict then fails any run
 *  where this job did not succeed, so a disarmed fleet caller fails
 *  closed at run time. check_ssot's all-green-name rule pins the same
 *  string against the wrapper template and both job ids. */
const REQUIRED_GATE_JOB = "ci / validate-template";

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** How a declared file's ownership is enforced in the rendered repo:
 *  "header" files open with the managed header, "marker" files carry their
 *  declared split marker line exactly once (a substring mention must not
 *  count), and "class-only" files are managed with no comment channel
 *  (pin dotfiles, JSON, symlinks) - nothing to check in-file, but check
 *  9's manifest cross-check still needs them on the roster, or a
 *  hand-flipped class would silently exempt them from byte parity. (A
 *  fourth kind, "mergeable", was retired with the class - settings.yml,
 *  its only member, is a repo-owned starter now.) */
type OwnedFile =
  | { path: string; kind: "header"; marker?: undefined }
  | { path: string; kind: "class-only"; marker?: undefined }
  | { path: string; kind: "marker"; marker: string };

/** Render conditions translated from the templates' declared filename
 *  gates, evaluated against a render's answers and modules list. */
type RenderWhen = { publicOnly?: boolean; withoutModule?: string };

type BaseOwnedFile = OwnedFile & { when?: RenderWhen };

// The declared ownership of every enforceable base file (kind + marker
// decoration, render conditions from the templates' filename gates) and
// the bounded-region split grammars; module files come from the generated
// MODULE_OWNERSHIP record below. Starters stay out (repo-owned; nothing
// to enforce); headerless comment-free managed files ride as class-only
// so the manifest cross-check covers them.
// BEGIN GENERATED: base-ownership (scripts/generate.ts - edit templates/base/ownership.yml and the base templates, not this block)
const BASE_OWNERSHIP: BaseOwnedFile[] = [
  { path: ".copier-answers.yml", kind: "header" },
  { path: ".editorconfig", kind: "marker", marker: "# repo-platform:local-section" },
  { path: ".gitattributes", kind: "marker", marker: "# repo-platform:local-section" },
  { path: ".github/CODEOWNERS", kind: "marker", marker: "# repo-platform:local-section" },
  { path: ".github/dependabot.yml", kind: "header" },
  { path: ".github/workflows/all-green.yml", kind: "header" },
  { path: ".github/workflows/ci.yml", kind: "header" },
  { path: ".repo-platform.yml", kind: "header" },
  { path: ".typography-allow", kind: "header" },
  { path: ".yamllint", kind: "header" },
  { path: "CODE_OF_CONDUCT.md", kind: "header", when: { publicOnly: true } },
  {
    path: "CONTRIBUTING.md",
    kind: "marker",
    marker: "<!-- repo-platform:local-section -->",
    when: { publicOnly: true },
  },
  {
    path: "LICENSE.md",
    kind: "marker",
    marker: "<!-- repo-platform:local-section -->",
    when: { withoutModule: "custom-license" },
  },
  { path: "SECURITY.md", kind: "marker", marker: "<!-- repo-platform:local-section -->" },
];

const BASE_REGION_SPLITS: Record<string, RegionSplit> = {
  ".gitignore": {
    managed_begin: "# BEGIN REPO-PLATFORM MANAGED",
    managed_end: "# END REPO-PLATFORM MANAGED",
    local_begin: "# BEGIN REPOSITORY LOCAL",
    local_end: "# END REPOSITORY LOCAL",
  },
};
// END GENERATED: base-ownership

/** Marker lines required exactly once per file (substring-counted, so a
 *  buried mention is a duplicate too), read from the declared
 *  bounded-region grammars' GRAMMAR row so the two can never drift apart. */
const MARKER_FILES: Record<string, string[]> = Object.fromEntries(
  Object.entries(BASE_REGION_SPLITS).map(([path, grammar]) => [
    path,
    [...GRAMMAR["bounded-region"].markers(grammar)],
  ]),
);

const TEXT_SUFFIXES = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyi",
  ".yml",
  ".yaml",
  ".json",
  ".jinja",
  ".md",
  ".html",
  ".css",
  ".toml",
  ".cfg",
  ".ini",
  ".txt",
  ".sh",
  ".astro",
  ".template",
]);

const ADVISORY_JOBS = ["actionlint", "gitleaks", "yamllint", "commit-names", "dependency-review"];

/** A step in the private merged shape counts only when nothing can disable
 *  it: no `if`, or exactly the shape's run-even-after-failure guard (bare
 *  or wrapped - GitHub treats `!cancelled()` and its expression form
 *  identically). */
function stepUnconditional(step: Record<string, unknown>): boolean {
  if (!("if" in step)) return true;
  if (typeof step.if !== "string") return false;
  const guard = step.if.trim();
  const inner = /^\$\{\{([\s\S]*)\}\}$/.exec(guard)?.[1]?.trim() ?? guard;
  return inner === "!cancelled()";
}

/** How each advisory check appears as a base-checks step in the private
 *  merged shape (dependency-review never renders there). The uses matchers
 *  are anchored to the full action identity, so a look-alike name from
 *  another owner or repository does not count; `ownedAction` matches this
 *  fleet's own composite actions. */
function mergedStepMarkers(
  ownedAction: (name: string) => RegExp,
): Record<string, (step: Record<string, unknown>) => boolean> {
  const uses = (step: Record<string, unknown>, action: RegExp) =>
    typeof step.uses === "string" && action.test(step.uses);
  return {
    actionlint: (step) => uses(step, /^raven-actions\/actionlint@/),
    gitleaks: (step) => uses(step, /^gitleaks\/gitleaks-action@/),
    yamllint: (step) => uses(step, ownedAction("yamllint")),
    "commit-names": (step) => uses(step, ownedAction("validate-commit-names")),
  };
}

// BEGIN GENERATED: known-modules (scripts/generate.ts - edit module.yml manifests, not this block)
const KNOWN_MODULES = new Set([
  "agents",
  "bun",
  "node",
  "deno",
  "uv",
  "rust",
  "pages",
  "release-please",
  "issue-templates",
  "skills",
  "pr-title",
  "auto-assign",
  "fuzzer",
  "nightly",
  "settings-sync",
  "custom-license",
]);
// END GENERATED: known-modules

// BEGIN GENERATED: toolchain-pins (scripts/generate.ts - edit module.yml manifests, not this block)
const TOOLCHAIN_PINS: Record<string, { file: string; version: string }> = {
  bun: { file: ".bun-version", version: "1.4.0" },
  node: { file: ".node-version", version: "24.19.0" },
  deno: { file: ".dvmrc", version: "2.9.5" },
};
// END GENERATED: toolchain-pins

// How each rendered module file declares its ownership while its module is
// selected: "header" files open with the managed header, "marker" files
// split a managed top from a repo-owned tail at their declared marker line,
// "class-only" files are managed with no comment channel (derived from the
// module.yml ownership declarations by moduleOwnershipEntries in
// scripts/ownership.ts - starters stay out).
// BEGIN GENERATED: module-ownership (scripts/generate.ts - edit the module.yml ownership declarations and the module templates, not this block)
const MODULE_OWNERSHIP: Record<string, OwnedFile[]> = {
  agents: [
    { path: ".github/agents.md", kind: "class-only" },
    { path: ".github/copilot-instructions.md", kind: "class-only" },
    { path: "AGENTS.md", kind: "marker", marker: "<!-- repo-platform:local-section -->" },
    { path: "CLAUDE.md", kind: "class-only" },
  ],
  bun: [
    { path: ".bun-version", kind: "class-only" },
    { path: ".github/workflows/dependabot-bun-lockfile.yml", kind: "header" },
  ],
  node: [{ path: ".node-version", kind: "class-only" }],
  deno: [
    { path: ".dvmrc", kind: "class-only" },
    { path: ".github/workflows/deno-audit.yml", kind: "header" },
  ],
  pages: [{ path: ".github/workflows/pages.yml", kind: "header" }],
  "release-please": [{ path: ".github/workflows/release.yml", kind: "header" }],
  skills: [{ path: ".github/workflows/validate-skills.yml", kind: "header" }],
  "auto-assign": [{ path: ".github/workflows/auto-assign.yml", kind: "header" }],
  "settings-sync": [{ path: ".github/workflows/settings-sync.yml", kind: "header" }],
};
// END GENERATED: module-ownership

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** A conflict-marker line: 7 angles + space, or exactly 7 equals. Checked
 *  per line (constructed, never literal - this file must pass its own scan). */
function hasConflictMarker(content: string): boolean {
  const angleLeft = `${"<".repeat(7)} `;
  const angleRight = `${">".repeat(7)} `;
  const equals = "=".repeat(7);
  return content
    .split("\n")
    .some((line) => line.startsWith(angleLeft) || line.startsWith(angleRight) || line === equals);
}

function safeLoadYaml(text: string): unknown {
  // Duplicate mapping keys are a real defect (the last value silently wins
  // at consumption time), so a file carrying them does not count as parsing.
  return parseYaml(text, { uniqueKeys: true });
}

/** Re-read for the structural checks below, which need the file's shape
 *  rather than its verdict. The walk already reports any duplicate key, so
 *  tolerating duplicates here avoids a second, wrong diagnostic (a ci.yml
 *  with one duplicate line is not an empty file needing a template sync). */
function shapeOfYaml(text: string): unknown {
  return parseYaml(text, { uniqueKeys: false });
}

/** Whether a duplicate mapping key in this path is an error rather than an
 *  advisory. Strict for .github/ plus the two root registration files:
 *  GitHub's own parsers reject duplicate keys there anyway, and a three-way
 *  merge can duplicate settings.yml's identity keys, where the later value
 *  silently wins at apply time. Elsewhere a duplicate can be deliberate (a
 *  parser fixture, a vendored config) - and a sync walks the whole target
 *  repo, so erroring there would make every sync PR permanently red. */
function isStrictYaml(rel: string): boolean {
  return (
    rel === ".copier-answers.yml" || rel === ".repo-platform.yml" || rel.startsWith(".github/")
  );
}

function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Untracked-and-ignored paths under `root`, from one `git ls-files
 *  --others --ignored --directory` pre-pass: `dirs` are ignored
 *  directories (reported collapsed, so the walk can prune them without
 *  ever descending - .claude/worktrees/ holds whole checkouts), `files`
 *  are individually ignored files. null when git cannot answer - no git
 *  on PATH, or root is not a git checkout - which is the honest reading
 *  of a plain tree: nothing is ignored. Only --self consults this (see
 *  the header). */
function gitIgnored(root: string): { dirs: Set<string>; files: Set<string> } | null {
  const proc = spawnSync(
    "git",
    ["-C", root, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
    { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (proc.error || proc.status !== 0) return null;
  const dirs = new Set<string>();
  const files = new Set<string>();
  for (const entry of proc.stdout.split("\0")) {
    if (entry === "") continue;
    if (entry.endsWith("/")) dirs.add(entry.slice(0, -1));
    else files.add(entry);
  }
  return { dirs, files };
}

/** All regular files below root, sorted, skipping SKIP_DIRS and (when
 *  `ignored` is given) gitignored paths - directories are pruned before
 *  descent. */
function walk(root: string, ignored: ReturnType<typeof gitIgnored> = null): string[] {
  const found: string[] = [];
  const visit = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (SKIP_DIRS.has(name)) continue;
      const stat = lstatSync(join(root, childRel));
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (!ignored?.dirs.has(childRel)) visit(childRel);
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        if (!ignored?.files.has(childRel)) found.push(childRel);
      }
    }
  };
  visit("");
  return found.sort();
}

function usageError(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

/** Findings as markdown, in TWO separate files because the two streams
 *  have different consequences: errors are what this process exits nonzero
 *  on, advisories never touch the exit code. One combined file made a
 *  caller treat "has content" as "blocks", which is wrong for an
 *  advisory-only run. Both are opt-in and neither changes any exit code, so
 *  a consumer that sets neither sees no difference. An empty set writes an
 *  EMPTY file rather than none, which is how a caller tells "nothing to
 *  report" from "the validator never ran". */
function writeFindings(errors: string[], advisories: string[]): void {
  const section = (title: string, items: string[]): string =>
    items.length === 0
      ? ""
      : `#### ${title} (${items.length})\n\n${items.map((i) => `- ${i}`).join("\n")}\n`;
  const write = (variable: string, text: string): void => {
    const path = process.env[variable];
    if (path !== undefined && path !== "") writeFileSync(path, text);
  };
  write("FINDINGS_FILE", section("Errors", errors));
  write("ADVISORIES_FILE", section("Advisories", advisories));
}

function main(): number {
  const argv = process.argv.slice(2);
  let selfMode = false;
  let target = ".";
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === "--self") selfMode = true;
    else if (arg.startsWith("-")) usageError(`unrecognized argument: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) usageError(`unrecognized argument: ${positional[1]}`);
  if (positional.length === 1) target = positional[0];

  const root = resolve(target);
  const errors: string[] = [];
  const advisories: string[] = [];

  // The template renders this fleet's composite actions as
  // <github_username>/repo-platform/actions/<name>@<ref>. A managed
  // render's answers must pin that owner (another owner's look-alike
  // action must not satisfy a check): a missing or malformed
  // github_username is a hard error, never a permissive fallback. Self
  // mode validates repo-platform itself, which has no answers file to
  // pin from, so any well-formed owner counts there. null = the error
  // below is already recorded and the owner-dependent checks stand
  // down until the answers are healed.
  const answersPath = join(root, ".copier-answers.yml");
  const hasAnswers = isRegularFile(answersPath);
  let answers: Record<string, unknown> = {};
  if (hasAnswers) {
    try {
      const parsed = shapeOfYaml(readFileSync(answersPath, "utf-8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        answers = parsed as Record<string, unknown>;
      }
    } catch {
      // The walk (check 3) reports the parse failure; the empty record
      // makes the github_username error below name the missing pin.
    }
  }
  const isPrivateRender = answers.private === true;
  const username = answers.github_username;
  const ownerPin: { kind: "pinned"; owner: string } | { kind: "any" } | null = selfMode
    ? { kind: "any" }
    : typeof username === "string" && /^[A-Za-z0-9-]+$/.test(username)
      ? { kind: "pinned", owner: username }
      : null;
  // A missing answers file gets check 1's own error; no second diagnostic
  // on the same root cause.
  if (ownerPin === null && hasAnswers) {
    errors.push(
      ".copier-answers.yml: `github_username` is missing or not a " +
        "GitHub username - it pins which owner's composite actions " +
        "ci.yml must use; restore the field or re-run a template sync",
    );
  }
  const ownedActionFor =
    (pin: { kind: "pinned"; owner: string } | { kind: "any" }) =>
    (name: string): RegExp => {
      const ownerPattern =
        pin.kind === "pinned" ? pin.owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "[A-Za-z0-9-]+";
      return new RegExp(`^${ownerPattern}/repo-platform/actions/${name}@`);
    };

  // The modules a valid .repo-platform.yml selects, for the checks gated on
  // module membership (7 and 8); null while the list is missing or
  // malformed (check 1's own error) and in self mode.
  let selectedModules: string[] | null = null;

  // 1. Registration files (not applicable to the template repo itself)
  if (!selfMode) {
    for (const required of [".copier-answers.yml", ".repo-platform.yml"]) {
      if (!isRegularFile(join(root, required))) {
        errors.push(
          `${required} is missing - the repo was not generated by the ` +
            "repo-platform template (or the file was deleted); restore it " +
            "from git history or regenerate with " +
            "'copier copy gh:Vivswan/repo-platform . --vcs-ref build'",
        );
      }
    }
    const registration = join(root, ".repo-platform.yml");
    if (isRegularFile(registration)) {
      let data: unknown = {};
      try {
        data = shapeOfYaml(readFileSync(registration, "utf-8")) ?? {};
      } catch {
        data = {};
      }
      const modules =
        typeof data === "object" && data !== null && !Array.isArray(data)
          ? (data as Record<string, unknown>).modules
          : null;
      if (!Array.isArray(modules)) {
        errors.push(
          ".repo-platform.yml: top-level `modules` is missing or not a list " +
            "(the file may have failed to parse); set it to a YAML list of " +
            "module names, e.g. modules: [uv, release-please]",
        );
      } else {
        selectedModules = modules.filter((m): m is string => typeof m === "string");
        const unknown = modules
          .filter((m) => typeof m !== "string" || !KNOWN_MODULES.has(m))
          .map((m) => String(m))
          .sort();
        if (unknown.length > 0) {
          errors.push(
            `.repo-platform.yml: unknown module(s): ${unknown.join(", ")} - ` +
              `valid modules are: ${[...KNOWN_MODULES].sort().join(", ")}; ` +
              "fix the modules list",
          );
        }
        // 7. Toolchain version pins: each selected pin-carrying module ships
        // its managed version dotfile, and setup steps read it, so drifted
        // content silently unpins the whole toolchain.
        for (const module of modules) {
          const pin = typeof module === "string" ? TOOLCHAIN_PINS[module] : undefined;
          if (!pin) continue;
          const pinPath = join(root, pin.file);
          if (!isRegularFile(pinPath)) {
            errors.push(
              `${pin.file} is missing - the ${module} module pins its toolchain ` +
                "version there and the template always generates it; restore the " +
                "file from git history or run a template sync",
            );
          } else if (readFileSync(pinPath, "utf-8") !== `${pin.version}\n`) {
            errors.push(
              `${pin.file}: content must be exactly '${pin.version}' plus a newline ` +
                `(the ${module} module's pinned toolchain version) - the file is ` +
                "managed, so a template sync heals it; version overrides belong in " +
                "the repo-owned workflows' explicit version inputs",
            );
          }
        }
        // packageManager is setup-bun's LAST fallback, dead once
        // .bun-version pins the toolchain - and a stale field is a second,
        // disagreeing pin. Advisory only: the field also drives corepack
        // shims some repos may rely on.
        if (modules.includes("bun")) {
          const pkgPath = join(root, "package.json");
          if (isRegularFile(pkgPath)) {
            let pkg: unknown = null;
            try {
              pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
            } catch {
              // An unparseable package.json is not this check's problem.
            }
            if (typeof pkg === "object" && pkg !== null && "packageManager" in pkg) {
              advisories.push(
                "package.json: packageManager is redundant (and can disagree) once " +
                  ".bun-version pins the toolchain - consider removing it " +
                  "(repo-platform docs/toolchains.md)",
              );
            }
          }
        }
      }
    }
  }

  // 2. Marker sections exactly once and in grammar order (.gitignore is
  // always generated by the template - absence means the repo is damaged,
  // not unconfigured). MARKER_FILES lists each file's markers in the
  // declared order (local BEGIN, local END, managed BEGIN, managed END);
  // counting alone would pass a reordered file whose managed-half hash is
  // unchanged (a swap above the managed BEGIN), so order is checked too.
  for (const [rel, markers] of Object.entries(MARKER_FILES)) {
    const path = join(root, rel);
    if (!isRegularFile(path)) {
      errors.push(
        `${rel} is missing - the template always generates it, so the repo ` +
          "is damaged; restore the file from git history or run a template sync",
      );
      continue;
    }
    // latin1 for byte fidelity, like the stamper and the sync rebuild: a
    // UTF-8 decode folds invalid sequences onto the replacement character,
    // which could mask or invent marker text. Counting stays SUBSTRING
    // semantics on purpose (see MARKER_FILES): a buried mention of a
    // region marker is a duplicate by the fleet-wide region convention.
    const content = readFileSync(path).toString("latin1");
    let exactlyOnce = true;
    for (const marker of markers) {
      const count = content.split(marker).length - 1;
      if (count !== 1) {
        exactlyOnce = false;
        errors.push(
          `${rel}: marker '${marker}' appears ${count} times (expected 1) - ` +
            "a merge or manual edit broke the managed sections; restore one " +
            "LOCAL section followed by one MANAGED section",
        );
      }
    }
    if (exactlyOnce) {
      const positions = markers.map((marker) => content.indexOf(marker));
      if (positions.some((at, index) => index > 0 && at <= positions[index - 1])) {
        errors.push(
          `${rel}: the managed/local markers appear out of order - the sections ` +
            "must run local BEGIN, local END, managed BEGIN, managed END; restore " +
            "the order via a template sync",
        );
      }
    }
  }

  // 6. One license file. GitHub, registries, and the fleet sync all pick
  // a single license per repo: LICENSE next to LICENSE.md means a stale
  // spelling survived the rename or a custom license collided with the
  // fleet one. lstat presence (not isRegularFile) so a symlinked license
  // still counts.
  const licenseSpellings = ["LICENSE", "LICENSE.md"].filter((name) => {
    try {
      lstatSync(join(root, name));
      return true;
    } catch {
      return false;
    }
  });
  if (licenseSpellings.length > 1) {
    errors.push(
      "LICENSE and LICENSE.md both exist - a repo must not carry both " +
        "spellings; keep the current license (fleet repos: LICENSE.md) " +
        "and delete the other (git history remains the record of prior " +
        "licensing; third-party notices can move below the license's " +
        "local-section marker)",
    );
  } else if (licenseSpellings[0] === "LICENSE") {
    advisories.push(
      "LICENSE: the fleet convention is LICENSE.md for every repo, custom " +
        "licenses included - rename it (GitHub detects both spellings)",
    );
  }

  // 3 + 4. YAML parses; no conflict markers
  for (const rel of walk(root, selfMode ? gitIgnored(root) : null)) {
    const path = join(root, rel);
    const suffix = extname(rel);
    if (suffix === ".yml" || suffix === ".yaml") {
      const text = readFileSync(path, "utf-8");
      try {
        safeLoadYaml(text);
      } catch (exc) {
        const syntaxError = (m: string) =>
          `${rel}: does not parse as YAML (${m}); fix the syntax at the position shown`;
        // Duplicate keys are syntactically valid YAML, so "fix the syntax"
        // would mislead; name the real problem.
        const duplicateReport = (m: string) =>
          `${rel}: duplicate mapping key (${m}) - the later value silently ` +
          "wins at consumption time; remove or rename the duplicate";
        // parse() throws only its first error and refuses multi-document
        // sources outright; re-parse per document so a valid multi-document
        // file passes and every real error is reported. doc.errors carries
        // only composer-stage problems, so each document is also converted:
        // a duplicate key must not mask a resolution failure (an unresolved
        // alias) that parse() would have thrown.
        let reported = false;
        const docs = parseAllDocuments(text, { uniqueKeys: true });
        // Every consumer of the strict set (GitHub's config readers, the
        // sync's answers parsing) reads one mapping and would silently
        // ignore every document past the first, so multi-document streams
        // stay hard errors there.
        if (docs.length > 1 && isStrictYaml(rel)) {
          reported = true;
          errors.push(
            `${rel}: multi-document YAML stream (${docs.length} documents) - this file's ` +
              "consumers read a single mapping and silently ignore the rest; merge the documents",
          );
        }
        for (const doc of docs) {
          for (const docError of doc.errors) {
            reported = true;
            const docMessage = docError.message.split("\n")[0];
            if (docError.code !== "DUPLICATE_KEY") {
              errors.push(syntaxError(docMessage));
            } else if (isStrictYaml(rel)) {
              errors.push(duplicateReport(docMessage));
            } else {
              advisories.push(duplicateReport(docMessage));
            }
          }
          try {
            doc.toJS();
          } catch (convError) {
            reported = true;
            errors.push(
              syntaxError(
                convError instanceof Error ? convError.message.split("\n")[0] : String(convError),
              ),
            );
          }
        }
        // An exception the per-document re-parse does not surface (e.g. a
        // conversion failure past parsing) still fails.
        if (!reported && (exc as { code?: string }).code !== "MULTIPLE_DOCS") {
          errors.push(syntaxError(exc instanceof Error ? exc.message.split("\n")[0] : String(exc)));
        }
      }
    }
    if (TEXT_SUFFIXES.has(suffix) || suffix === "") {
      let content: string;
      try {
        content = STRICT_UTF8.decode(readFileSync(path));
      } catch {
        continue;
      }
      if (hasConflictMarker(content)) {
        errors.push(
          `${rel}: contains unresolved merge-conflict markers left by ` +
            "copier or git; edit the file and resolve each conflict block",
        );
      }
    }
  }

  // 5. The all-green gate in ci.yml. The file is template-managed and
  // always generated (repo-specific jobs live in the repo-owned checks.yml
  // it calls), so a missing ci.yml means the repo is damaged.
  //
  // Verdict shape (no all-green job): the required check is a CHECK RUN a
  // workflow_run-triggered verdict workflow creates after judging the
  // completed CI run's jobs, so what must exist is that workflow, wired.
  // A repo that lost it never gets the required check created again -
  // fail-closed, but worth a named error.
  const verdictWorkflowErrors = (): string[] => {
    const rel = ".github/workflows/all-green.yml";
    const verdictPath = join(root, ".github", "workflows", "all-green.yml");
    if (!isRegularFile(verdictPath)) {
      return [
        `ci.yml: no \`all-green\` job and no ${rel} verdict workflow - the ` +
          "required all-green check is never created and nothing can merge; " +
          "restore the verdict workflow from git history or run a template sync",
      ];
    }
    let workflow: unknown = {};
    try {
      workflow = shapeOfYaml(readFileSync(verdictPath, "utf-8")) ?? {};
    } catch {
      workflow = {};
    }
    const record = (value: unknown): Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const doc = record(workflow);
    const on = record(doc.on);
    const found: string[] = [];
    const workflowRun = record(on.workflow_run);
    const workflows = workflowRun.workflows;
    if (!Array.isArray(workflows) || !workflows.map(String).includes("CI")) {
      found.push(
        `${rel}: must trigger on workflow_run of the CI workflow - without ` +
          "that trigger no verdict (and no required all-green check) is ever created",
      );
    }
    const types = workflowRun.types;
    if (!Array.isArray(types) || types.length !== 1 || String(types[0]) !== "completed") {
      found.push(
        `${rel}: the workflow_run trigger must carry exactly types: [completed] - ` +
          "anything else also fires the verdict on requested/in_progress and " +
          "judges a run that has not finished",
      );
    }
    if (!("sha" in record(record(on.workflow_dispatch).inputs))) {
      found.push(
        `${rel}: must carry a workflow_dispatch \`sha\` input - the unwedge ` +
          "path that re-judges a commit when its workflow_run event was lost",
      );
    }
    // The shared judgment must be the TRUSTED one: the local reusable, or
    // <owner>/repo-platform's - a third-party workflow merely NAMED
    // reusable-all-green.yml must not mint the required check.
    const trustedUses =
      /^(?:\.\/|[A-Za-z0-9-]+\/repo-platform\/)\.github\/workflows\/reusable-all-green\.yml(?:@|$)/;
    const verdictJob = Object.values(record(doc.jobs))
      .map(record)
      .find((job) => trustedUses.test(String(job.uses ?? "")));
    if (verdictJob === undefined) {
      found.push(
        `${rel}: no job calls repo-platform's reusable-all-green.yml - the ` +
          "shared verdict judgment is what creates the all-green check run",
      );
    } else {
      if (verdictJob.if !== undefined) {
        found.push(
          `${rel}: the verdict job carries a job-level if: - a condition ` +
            "could silently stop every verdict; remove it",
        );
      }
      const grants = record(verdictJob.permissions);
      if (grants.checks !== "write") {
        found.push(
          `${rel}: the verdict job must grant checks: write - without it ` +
            "the check-run POST is refused and no verdict ever lands",
        );
      }
      if (grants.actions !== "read") {
        found.push(
          `${rel}: the verdict job must grant actions: read - the judgment ` +
            "reads the CI run's jobs through it",
        );
      }
      if (!/\binputs\.sha\b/.test(String(record(verdictJob.with).sha ?? ""))) {
        found.push(
          `${rel}: the verdict job must forward the dispatch sha ` +
            "(with.sha carrying inputs.sha) or the unwedge path is dead",
        );
      }
      // Client renders must pin the verdict's anchor job: the reusable
      // fails any run where "ci / validate-template" did not succeed,
      // which is what makes a disarmed fleet-ci caller (deleted,
      // conditioned, or info-renamed) fail closed at run time instead of
      // passing on the repo-owned checks alone. Self mode is exempt:
      // repo-platform's own gating jobs are roster-pinned by check_ssot.
      if (!selfMode && String(record(verdictJob.with)["require-job"] ?? "") !== REQUIRED_GATE_JOB) {
        found.push(
          `${rel}: the verdict job must pin require-job: ${REQUIRED_GATE_JOB} - ` +
            "that anchor is what makes a disarmed fleet-ci caller fail the " +
            "verdict instead of passing on the repo-owned checks alone; " +
            "restore the managed wrapper via a template sync",
        );
      }
    }
    return found;
  };
  const ciPath = join(root, ".github", "workflows", "ci.yml");
  if (!isRegularFile(ciPath)) {
    errors.push(
      ".github/workflows/ci.yml is missing - the template always " +
        "generates and manages it; restore the file from git history or " +
        "run a template sync",
    );
  } else {
    let ci: unknown = {};
    try {
      ci = shapeOfYaml(readFileSync(ciPath, "utf-8")) ?? {};
    } catch {
      ci = {};
    }
    const jobs =
      typeof ci === "object" && ci !== null && !Array.isArray(ci)
        ? ((ci as Record<string, unknown>).jobs as Record<string, unknown> | null | undefined)
        : null;
    if (!jobs || typeof jobs !== "object" || Object.keys(jobs).length === 0) {
      errors.push(
        "ci.yml: exists but defines no jobs - the file is empty or failed " +
          "to parse as YAML; restore the managed file via a template sync",
      );
    } else {
      const jobNeeds = (job: unknown): string[] => {
        const needs =
          typeof job === "object" && job !== null && !Array.isArray(job)
            ? (job as Record<string, unknown>).needs
            : null;
        if (typeof needs === "string") return [needs];
        return Array.isArray(needs) ? needs.map(String) : [];
      };
      const jobSteps = (job: unknown): Record<string, unknown>[] => {
        const steps =
          typeof job === "object" && job !== null && !Array.isArray(job)
            ? (job as Record<string, unknown>).steps
            : null;
        if (!Array.isArray(steps)) return [];
        return steps.filter(
          (step): step is Record<string, unknown> =>
            typeof step === "object" && step !== null && !Array.isArray(step),
        );
      };
      if (!("all-green" in jobs)) {
        errors.push(...verdictWorkflowErrors());
        // The verdict judges only jobs that RAN, so the render validator
        // must require the jobs' EXISTENCE here: a managed ci.yml whose
        // fleet-ci caller was deleted or conditioned away would leave the
        // repo-owned `checks` call as the whole run and the verdict green
        // - every fleet gate silently dropped. The owner comes from the
        // pinned answers, like the composite-action checks: a look-alike
        // under another owner is not the fleet's gate home. Self mode is
        // exempt: repo-platform's own gating jobs are roster-pinned by
        // check_ssot's all-green-roster rule instead.
        if (!selfMode && ownerPin !== null) {
          const ownerPattern =
            ownerPin.kind === "pinned"
              ? ownerPin.owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
              : "[A-Za-z0-9-]+";
          const fleetCiUses = new RegExp(
            `^${ownerPattern}/repo-platform/\\.github/workflows/fleet-ci\\.yml@`,
          );
          const fleetCaller = Object.values(jobs)
            .map((job) =>
              typeof job === "object" && job !== null && !Array.isArray(job)
                ? (job as Record<string, unknown>)
                : {},
            )
            .find((job) => fleetCiUses.test(String(job.uses ?? "")));
          if (fleetCaller === undefined) {
            errors.push(
              "ci.yml: no job calls repo-platform's fleet-ci.yml reusable - " +
                "the fleet's gate jobs never run and the verdict passes on " +
                "the repo-owned checks alone; restore the managed `ci` job " +
                "via a template sync",
            );
          } else if (fleetCaller.if !== undefined) {
            errors.push(
              "ci.yml: the fleet-ci caller job carries a job-level if: - a " +
                "skipped caller contributes no gate jobs and the verdict " +
                "passes without them; remove the condition",
            );
          }
        }
      } else {
        const rawAllGreen = jobs["all-green"];
        const allGreen: Record<string, unknown> =
          typeof rawAllGreen === "object" && rawAllGreen !== null && !Array.isArray(rawAllGreen)
            ? (rawAllGreen as Record<string, unknown>)
            : {};
        const needs = jobNeeds(allGreen);
        // release-please style jobs that run after the gate are exempt.
        const downstream = new Set(
          Object.entries(jobs)
            .filter(([name, job]) => name !== "all-green" && jobNeeds(job).includes("all-green"))
            .map(([name]) => name),
        );
        // No informational exemption any more. validate-template used to
        // hold one, back when it only flagged drift; it now blocks on an
        // integrity failure (managed content changed outside a sync), so a
        // ci.yml that leaves it out of `needs` has disarmed a real gate and
        // must be told so.
        const missing = Object.keys(jobs)
          .filter((name) => name !== "all-green" && !downstream.has(name) && !needs.includes(name))
          .sort();
        if (missing.length > 0) {
          errors.push(
            `ci.yml: all-green \`needs:\` is missing job(s): ` +
              `${missing.join(", ")} - those jobs cannot gate ` +
              "merges; add them to the all-green job's needs list",
          );
        }
        const ifValue = typeof allGreen.if === "string" ? allGreen.if.trim() : "";
        if (ifValue !== "always()") {
          errors.push(
            "ci.yml: the all-green job must carry exactly `if: always()` - " +
              "without it a failed dependency skips the gate instead of " +
              "failing it, and extra conditions weaken the gate",
          );
        }
        const steps = Array.isArray(allGreen.steps) ? allGreen.steps : [];
        const hasGateStep = steps.some((step) => {
          const run =
            typeof step === "object" && step !== null && !Array.isArray(step)
              ? (step as Record<string, unknown>).run
              : null;
          return typeof run === "string" && run.includes('!= "success"') && run.includes("exit 1");
        });
        if (!hasGateStep) {
          errors.push(
            "ci.yml: the all-green job has no step failing on non-success " +
              "results - it must iterate needs results and `exit 1` on any " +
              'result `!= "success"` so failed, cancelled, and skipped jobs ' +
              "all block the merge",
          );
        }
      }
      // The template renders this fleet's composite actions with the owner
      // pinned from the answers (hoisted above, shared with check 8).
      // The render shape decides what the remaining checks require: a
      // base-checks job means the private merged shape (the five base
      // checks are its steps), anything else is the public fan-out.
      // Resolved once so no check mixes expectations from both shapes.
      // Legacy-shape-only checks (they read the aggregate job's sibling
      // jobs): under the verdict shape the base checks live in the
      // fleet-ci reusable, invisible to this tree.
      const legacyShape = "all-green" in jobs;
      const shape =
        "base-checks" in jobs
          ? ({ kind: "private-merged", steps: jobSteps(jobs["base-checks"]) } as const)
          : ({ kind: "public-fanout" } as const);
      if (!legacyShape) {
        // Nothing further to require of ci.yml's own jobs here.
      } else if (shape.kind === "private-merged") {
        if (ownerPin !== null) {
          const action = ownedActionFor(ownerPin)("check-typography");
          const enforced = shape.steps.some(
            (step) =>
              typeof step.uses === "string" && action.test(step.uses) && stepUnconditional(step),
          );
          // base-checks itself must gate the merge, which the all-green
          // needs check above already errors on - no separate check here.
          if (!enforced) {
            errors.push(
              "ci.yml: base-checks has no unconditional check-typography step " +
                "(private renders carry the typography check there) - the " +
                "no-look-alike-characters rule is unenforced; add a step using " +
                "Vivswan/repo-platform/actions/check-typography",
            );
          }
        }
      } else if (!("typography" in jobs)) {
        errors.push(
          "ci.yml: no `typography` job - the no-look-alike-characters rule " +
            "is unenforced; add a job using " +
            "Vivswan/repo-platform/actions/check-typography",
        );
      }
      // dependency-review renders only on public repos (the dependency
      // graph behind it is free just there), so a private render's answers
      // silence that advisory instead of nagging about a job it must not
      // have. Self mode has no answers file and is public anyway.
      const stepMarkers = ownerPin === null ? null : mergedStepMarkers(ownedActionFor(ownerPin));
      for (const advisory of legacyShape ? ADVISORY_JOBS : []) {
        if (advisory === "dependency-review") {
          if (!isPrivateRender && !(advisory in jobs)) {
            advisories.push(`ci.yml: consider adding a \`${advisory}\` job`);
          }
          continue;
        }
        if (shape.kind === "private-merged") {
          const marker = stepMarkers?.[advisory];
          if (marker && !shape.steps.some((step) => marker(step) && stepUnconditional(step))) {
            advisories.push(
              `ci.yml: base-checks is missing the ${advisory} check - consider adding its step`,
            );
          }
        } else if (!(advisory in jobs)) {
          advisories.push(`ci.yml: consider adding a \`${advisory}\` job`);
        }
      }
    }
  }

  // The version-aligned ownership roster this validator declares ITSELF:
  // the generated base table (its `when` conditions are the templates'
  // declared filename gates, translated) plus the selected modules'
  // generated entries (a null modules list stands the module-gated and
  // module-conditioned entries down - check 1 already errored). Check 8
  // enforces the in-file declarations over it; check 9 cross-checks the
  // manifest's class metadata against it.
  const whenHolds = (when?: RenderWhen): boolean => {
    if (when === undefined) return true;
    if (when.publicOnly && isPrivateRender) return false;
    if (when.withoutModule !== undefined) {
      if (selectedModules === null || selectedModules.includes(when.withoutModule)) return false;
    }
    return true;
  };
  const declaredOwnership: ({ rel: string } & OwnedFile)[] = BASE_OWNERSHIP.filter((entry) =>
    whenHolds(entry.when),
  ).map(({ when: _when, ...entry }) => ({ rel: entry.path, ...entry }));
  if (selectedModules !== null) {
    for (const module of selectedModules) {
      for (const entry of MODULE_OWNERSHIP[module] ?? []) {
        declaredOwnership.push({ rel: entry.path, ...entry });
      }
    }
  }

  // 8. Ownership self-declarations: every sync-managed file that supports
  // comments tells its readers who owns it - the managed header on files
  // sync wholly overwrites, the local-section marker splitting split files'
  // managed top from the repo-owned tail. Existing files only: a missing
  // managed file is damage the next sync heals (ci.yml and .gitignore
  // absence already error above). Skipped in self mode - the template
  // repo's files are sources, not renders - and while the owner pin is
  // unhealed (its error is already recorded).
  if (!selfMode && ownerPin !== null && ownerPin.kind === "pinned") {
    // Anchored on the header sentence's canonical trailing period with no
    // repo-name character (GitHub allows [A-Za-z0-9._-]) after it, so
    // neither a negated look-alike ("is not managed by") nor a longer repo
    // name ("/repo-platform_fork", "/repo-platform.fork") counts.
    const headerRe = new RegExp(
      `This file is managed by ${ownerPin.owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` +
        "/repo-platform\\.(?![A-Za-z0-9._-])",
    );
    for (const { rel, kind, marker } of declaredOwnership) {
      // class-only files have no comment channel to self-declare in; their
      // enforcement is check 9's manifest cross-check alone.
      if (kind === "class-only") continue;
      const path = join(root, rel);
      if (!isRegularFile(path)) continue;
      // latin1, matching the stamper's and sync rebuild's byte-level marker
      // predicate: a UTF-8 decode turns multibyte whitespace into
      // characters trim() strips, counting a line as the marker that the
      // byte-level matchers (and the stamped managed half) do not.
      const content = readFileSync(path).toString("latin1");
      if (kind === "header") {
        if (!headerRe.test(content.split("\n", HEADER_WINDOW).join("\n"))) {
          errors.push(
            `${rel}: does not open with the managed header ('This file is ` +
              `managed by ${ownerPin.owner}/repo-platform.') - the file is ` +
              "overwritten by template sync and the header is what warns readers " +
              "their local edits get replaced; run a template sync to restore it",
          );
        }
      } else {
        const count = content.split("\n").filter((line) => line.trim() === marker).length;
        if (count !== 1) {
          errors.push(
            `${rel}: the '${marker}' marker line appears ${count} ` +
              "times (expected 1) - it splits the sync-managed top of the file " +
              "from this repository's own tail; restore the single marker line " +
              "via a template sync",
          );
        }
      }
    }
  }

  // 9. Ownership-manifest byte parity. The manifest is itself a managed
  // render, so client repos carry it and the template repo must NOT (self
  // mode inverts - repo-platform is not a render of itself). A
  // conflict-marked manifest is check 4's report; there is nothing
  // coherent to hash. Findings are informational by stance:
  // validate-template does not gate client merges. The manifest's
  // ownership METADATA, however, is NOT trusted for the paths this
  // validator's tables cover (declaredOwnership above, plus .gitignore's
  // marker grammar): the sync BASELINES non-conflicting local manifest
  // edits rather than healing them, so a hand-flipped class (managed ->
  // starter) would otherwise disable parity for that path permanently and
  // invisibly. A class or split-metadata mismatch, or an entry whose
  // render condition is off, is an error. ABSENCE is strict: every build
  // ships the manifest (the fleet is fully migrated; no pre-manifest
  // renders exist), so a missing manifest can only be deletion or damage.
  // PROVENANCE is strict the same way: the stamper writes the render's
  // recorded _commit into the self entry verbatim (null exactly when the
  // answers record none), so a stamp that differs from the recorded value
  // - a null where a _commit is recorded included - is tampering or a
  // failed stamp. A missing roster entry whose file still exists is the
  // deletion attack parity guards against and errors; once a provenance
  // error has already been reported, absence stays an advisory naming that
  // error instead of piling a second diagnostic per entry onto the same
  // cause. The strict deletion error additionally requires the missing
  // entry's FILE to still exist (see reportUnlisted): a table path with no
  // file is a retired or not-yet-delivered path seen by a validator of a
  // different vintage (client pins float at main; the sync runs a
  // version-aligned checkout), not stealth drift. No in-repo signal can be
  // tamper-proof against the repo's own owner (who can as easily drop the
  // validate-template job); the guarantee is VISIBILITY, not prevention:
  // every absence surfaces on every run, and a tampered _commit both
  // self-heals on the next sync (template and local change the same line,
  // and conflicts resolve toward the template) and breaks the repo's own
  // update base loudly. Version pins and symlinks ride the tables as
  // class-only entries (no in-file decoration, but their manifest class is
  // cross-checked); only starter paths remain manifest-trusted, an
  // accepted residue of the informational stance.
  // The _commit read must mirror sync/answers_file.ts's failsafe-schema
  // read: PyYAML (copier's writer) dumps exponent-shaped shas like
  // 95e1875 UNQUOTED (its float pattern needs a dot or signed exponent),
  // while the yaml package's core schema resolves digits-e-digits to a
  // float - a typed read turns ~2% of build shas into Infinity and a
  // false tampering report. Re-read the one key under failsafe, where
  // every scalar stays a string.
  const answersCommit = ((): string | null => {
    if (!hasAnswers) return null;
    try {
      const raw = parseYaml(readFileSync(answersPath, "utf-8"), {
        schema: "failsafe",
        logLevel: "error",
      }) as Record<string, unknown>;
      const value = raw?._commit;
      return typeof value === "string" && value !== "" ? value : null;
    } catch {
      return null;
    }
  })();
  const manifestPath = join(root, MANIFEST_NAME);
  const manifestExists = isRegularFile(manifestPath);
  if (selfMode) {
    if (manifestExists) {
      errors.push(
        `${MANIFEST_NAME}: exists in the template repository - the ownership ` +
          "manifest lands only in generated repos (this repo dogfoods " +
          "individual template twins, never a full render of itself); delete it",
      );
    }
  } else if (!manifestExists) {
    errors.push(
      `${MANIFEST_NAME} is missing - every build ships it, so this is ` +
        "deletion or damage; restore it from git history or run a recovery " +
        "sync (recover=recopy)",
    );
  } else {
    const manifestText = readFileSync(manifestPath, "utf-8");
    let manifestFiles: Record<string, ManifestEntryShape> | null = null;
    if (!hasConflictMarker(manifestText)) {
      // The shared parser (actions/shared/manifest.ts - the same one the
      // stamper and the sync legs read through) rejects unparseable JSON,
      // a missing 'files' mapping, non-object entries, and structurally
      // duplicated keys, which JSON consumers would otherwise last-win
      // silently. It is only reached on conflict-free text: the parser
      // resolves conflict blocks toward the template side (its sync-side
      // contract), and this validator must report a conflicted manifest
      // (check 4), never quietly read one side of it.
      const parsed = parseManifestFiles(manifestText);
      if (parsed.problem !== null) {
        errors.push(
          `${MANIFEST_NAME}: ${parsed.problem} - the file is managed; revert ` +
            "the edit (git history has the stamped original) or run a " +
            "recovery sync (recover=recopy)",
        );
      } else {
        manifestFiles = parsed.files;
      }
    }
    if (manifestFiles !== null) {
      if (!(MANIFEST_NAME in manifestFiles)) {
        errors.push(
          `${MANIFEST_NAME}: does not list itself - the manifest is a managed ` +
            "render like any other; run a template sync to regenerate it",
        );
      }
      // Roster cross-check (see the trust model above): the manifest's
      // class metadata must agree with this validator's own tables for
      // every path they cover. Entry values are objects with a string
      // class (the shared parser rejected everything else); every other
      // field stays unknown and is validated where it is used.
      // Provenance: the stamped commit on the self entry must EQUAL the
      // recorded answers _commit - the stamper always writes the value it
      // reads there (null exactly when the answers record none), so any
      // difference, a null stamp against a recorded _commit included, is
      // tampering or a failed stamp. Absence checks are strict unless a
      // provenance error was already reported; `absenceCaveat` (null =
      // strict) carries that error's name into the per-entry advisory,
      // so one cause never piles a second diagnostic per missing entry.
      const rawSelfCommit = manifestFiles[MANIFEST_NAME]?.commit;
      const manifestCommit = typeof rawSelfCommit === "string" ? rawSelfCommit : null;
      let absenceCaveat: string | null = null;
      if (manifestCommit === null && answersCommit !== null) {
        errors.push(
          `${MANIFEST_NAME}: its provenance stamp is null but the render ` +
            `records _commit ${answersCommit}, which the stamper always ` +
            "writes - tampering or a failed stamp; revert the edit or " +
            "run a recovery sync (recover=recopy)",
        );
        absenceCaveat = "its provenance stamp is unusable (error above)";
      } else if (manifestCommit !== null && manifestCommit !== answersCommit) {
        errors.push(
          `${MANIFEST_NAME}: its stamped provenance (self-entry commit ` +
            `'${manifestCommit}') does not match the recorded render ` +
            `${answersCommit === null ? "(no _commit in .copier-answers.yml)" : answersCommit} - ` +
            "the stamper always writes the recorded value, so this is " +
            "tampering or a failed stamp; revert the edit or run a recovery " +
            "sync (recover=recopy)",
        );
        absenceCaveat = "its provenance stamp is unusable (error above)";
      }
      const reportUnlisted = (rel: string, declaredBy: string) => {
        let fileExists = false;
        try {
          lstatSync(join(root, rel));
          fileExists = true;
        } catch {
          fileExists = false;
        }
        // The strict deletion error requires the FILE to still exist: the
        // stealth attack parity guards against is an unlisted path whose
        // file lives on for quiet editing. An absent file is a version
        // split the fleet legitimately produces (withheld workflow files
        // pin an older ci.yml; client validators float at main, ahead of
        // the render), where a retired or not-yet-delivered table path has
        // no file - erroring there would be false.
        if (absenceCaveat === null && fileExists) {
          errors.push(
            `${MANIFEST_NAME} does not list '${rel}', which ${declaredBy} - the ` +
              `stamper writes every entry of its render (${answersCommit}), so ` +
              "the entry was deleted by hand, and sync baselines manifest edits; " +
              "revert it (git history has the stamped original) or run a " +
              "recovery sync (recover=recopy)",
          );
        } else {
          advisories.push(
            `${MANIFEST_NAME} does not list '${rel}', which ${declaredBy} - ` +
              `${
                absenceCaveat ??
                "the path is absent from the repo too, so this is a retired " +
                  "or not-yet-delivered path seen by a validator of a " +
                  "different vintage, not stealth drift"
              } (a hand-deleted entry needs reverting; sync baselines manifest edits)`,
          );
        }
      };
      const metadataError = (rel: string, claim: string, declared: string) => {
        errors.push(
          `${MANIFEST_NAME}: entry '${rel}' ${claim} but this validator's ` +
            `ownership tables declare it ${declared} - a hand edit here would ` +
            "silently disable or skew byte parity, and sync baselines manifest " +
            "edits instead of healing them; revert the entry (git history has " +
            "the stamped original) or run a recovery sync (recover=recopy), " +
            "which re-renders the manifest without a merge",
        );
      };
      for (const { rel, kind, marker } of declaredOwnership) {
        const entry = manifestFiles[rel];
        if (entry === undefined) {
          reportUnlisted(rel, "this validator's ownership tables declare");
          continue;
        }
        const declared = kind === "marker" ? "split" : "managed";
        if (entry.class !== declared) {
          metadataError(rel, `claims class ${JSON.stringify(entry.class)}`, declared);
          continue;
        }
        // A present grammar must name the declared one; a MISSING grammar
        // field is a shape problem, reported once by the structural loop
        // below (every render stamps the field), not doubled here.
        if (
          kind === "marker" &&
          (entry.managed !== GRAMMAR["tail-marker"].side ||
            entry.marker !== marker ||
            ("grammar" in entry && entry.grammar !== "tail-marker"))
        ) {
          metadataError(
            rel,
            "carries split metadata outside its declared tail-marker grammar",
            `split with the managed half above the '${marker}' marker line`,
          );
        }
      }
      // Bounded-region splits (.gitignore's grammar: the repo-owned LOCAL
      // region sits above the managed half), from the declared grammars.
      for (const [rel, grammar] of Object.entries(BASE_REGION_SPLITS)) {
        const entry = manifestFiles[rel];
        if (entry === undefined) {
          reportUnlisted(rel, "the template always renders");
          continue;
        }
        const markerPairOk =
          entry.class === "split" &&
          entry.marker === grammar.managed_begin &&
          entry.managed === GRAMMAR["bounded-region"].side;
        // A missing grammar field is the structural loop's single report;
        // a present one must name the declared grammar and its strings
        // (the GRAMMAR row's wireExtras column names the fields, so this
        // check follows a new field automatically).
        const grammarOk =
          !("grammar" in entry) ||
          (entry.grammar === "bounded-region" &&
            GRAMMAR["bounded-region"].wireExtras.every((field) => entry[field] === grammar[field]));
        if (!markerPairOk || !grammarOk) {
          metadataError(
            rel,
            "does not match the managed-section grammar",
            `split with the managed half below "${grammar.managed_begin}"`,
          );
        }
      }
      // An entry for a table-covered path whose render condition is off
      // (an unselected module's workflow, a public-only file on a private
      // render) cannot come from the template; it is manifest drift.
      const expectedPaths = new Set([
        ...declaredOwnership.map((f) => f.rel),
        ...Object.keys(BASE_REGION_SPLITS),
      ]);
      const coveredEver = new Set<string>([
        ...BASE_OWNERSHIP.filter(
          (entry) => entry.when?.withoutModule === undefined || selectedModules !== null,
        ).map((entry) => entry.path),
        ...Object.keys(BASE_REGION_SPLITS),
        ...(selectedModules !== null
          ? Object.values(MODULE_OWNERSHIP).flatMap((entries) => entries.map((f) => f.path))
          : []),
      ]);
      for (const rel of Object.keys(manifestFiles)) {
        if (coveredEver.has(rel) && !expectedPaths.has(rel)) {
          errors.push(
            `${MANIFEST_NAME}: entry '${rel}' should not exist for this render ` +
              "(its module is unselected or its render condition is off) - " +
              "manifest drift, which sync baselines rather than heals; revert " +
              "the entry or run a recovery sync (recover=recopy)",
          );
        }
      }
      for (const [rel, entry] of Object.entries(manifestFiles)) {
        const where = `${MANIFEST_NAME}: entry '${rel}'`;
        // The self entry's invariant comes before any class dispatch: a
        // corrupted class (say, starter) must not slip past it. Its commit
        // slot holds the provenance stamp (null or a string; the alignment
        // logic above judges the value).
        if (rel === MANIFEST_NAME) {
          if (
            entry.class !== "managed" ||
            entry.hash !== null ||
            ("commit" in entry && entry.commit !== null && typeof entry.commit !== "string")
          ) {
            errors.push(
              `${where} must be managed with hash null (its content includes ` +
                "every other hash, so a self-hash would be circular) and a " +
                "null-or-string provenance commit; run a template sync to " +
                "regenerate it",
            );
          }
          continue;
        }
        if (entry.class === "starter") {
          if ("hash" in entry) {
            errors.push(
              `${where} is a starter carrying a hash - starters are repo-owned ` +
                "after the first render, so sync makes no byte-parity promise " +
                "about them; run a template sync to regenerate the manifest",
            );
          }
          continue;
        }
        if (entry.class === "mergeable") {
          // The class was retired: settings.yml, its only member, is a
          // repo-owned starter now (_skip_if_exists), and its baseline is
          // computed centrally at apply time. A manifest still claiming it
          // predates that sync; the next sync re-renders the manifest.
          errors.push(
            `${where} has class "mergeable", which is retired - the next template ` +
              "sync re-renders the manifest (settings.yml became a repo-owned starter)",
          );
          continue;
        }
        if (entry.class !== "managed" && entry.class !== "split") {
          errors.push(
            `${where} has unknown class ${JSON.stringify(entry.class)} (expected ` +
              "managed, split, or starter); run a template sync to " +
              "regenerate the manifest",
          );
          continue;
        }
        const hash = "hash" in entry ? entry.hash : undefined;
        if (hash !== null && !(typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))) {
          errors.push(
            `${where}: hash must be null or a lowercase sha256 hex digest; ` +
              "run a template sync to regenerate and restamp the manifest",
          );
          continue;
        }
        let split: { marker: string; managed: "above" | "below" } | null = null;
        if (entry.class === "split") {
          if (
            typeof entry.marker !== "string" ||
            (entry.managed !== "above" && entry.managed !== "below")
          ) {
            errors.push(
              `${where} is split but lacks a marker line and a managed half of ` +
                '"above" or "below"; run a template sync to regenerate the manifest',
            );
            continue;
          }
          // Every render stamps the grammar field; the derived
          // marker/managed pair alone cannot say which grammar the sync
          // rebuild uses, so a split entry without one is a hand edit.
          if (!("grammar" in entry)) {
            errors.push(
              `${where} lacks the split grammar field every render stamps - a hand ` +
                "edit, and sync baselines manifest edits instead of healing them; " +
                "revert the entry (git history has the stamped original) or run a " +
                "recovery sync (recover=recopy)",
            );
            continue;
          }
          // A present grammar must agree with the managed side its GRAMMAR
          // row declares (the one statement of each grammar's side) and
          // carry the row's wireExtras marker strings (the one statement
          // of each grammar's field set). knownGrammar is the table's own
          // membership test for untyped manifest JSON.
          const grammarId = knownGrammar(entry.grammar);
          const grammarProblem =
            grammarId === null
              ? `declares unknown split grammar ${JSON.stringify(entry.grammar)}`
              : entry.managed !== GRAMMAR[grammarId].side
                ? `declares the ${grammarId} grammar with a managed half not ` +
                  JSON.stringify(GRAMMAR[grammarId].side)
                : GRAMMAR[grammarId].wireExtras.some((field) => typeof entry[field] !== "string")
                  ? `declares the ${grammarId} grammar without its region marker strings`
                  : null;
          if (grammarProblem !== null) {
            errors.push(
              `${where} ${grammarProblem}; run a template sync to regenerate the manifest`,
            );
            continue;
          }
          split = { marker: entry.marker, managed: entry.managed };
        }
        let stat: ReturnType<typeof lstatSync> | null = null;
        try {
          stat = lstatSync(join(root, rel));
        } catch {
          stat = null;
        }
        if (stat === null) {
          // Check 8's absence stance: a missing managed file is damage the
          // next sync heals - and the warn-and-withhold push path
          // legitimately delivers a manifest listing a workflow file the
          // token could not create. Advisory, not error.
          advisories.push(
            `${rel}: listed as ${entry.class} in ${MANIFEST_NAME} but missing ` +
              "from the repo - the next template sync restores it (workflow " +
              "files may have been withheld by a token without the Workflows scope)",
          );
          continue;
        }
        if (hash === null) {
          errors.push(
            `${rel}: ${MANIFEST_NAME} records no hash for it (unstamped) - the ` +
              "render's stamp hook did not run; run a template sync (or bun " +
              "stamp_manifest.ts from the build branch) to stamp it",
          );
          continue;
        }
        let actual: string | null;
        if (stat.isSymbolicLink()) {
          // Raw link bytes: decoding a malformed-UTF-8 target would fold
          // distinct targets onto the replacement character.
          actual = sha256(readlinkSync(join(root, rel), { encoding: "buffer" }));
        } else if (!stat.isFile()) {
          errors.push(
            `${rel}: listed in ${MANIFEST_NAME} but is neither a regular file ` +
              "nor a symlink; run a template sync to restore the managed render",
          );
          continue;
        } else {
          const content = readFileSync(join(root, rel)).toString("latin1");
          if (split !== null) {
            const half = managedHalf(content, split.marker, split.managed);
            // Fail closed: without the marker line there is nothing to
            // verify parity against, and a corrupted manifest reclassifying
            // a file as split must not silently exempt it. For the known
            // split files this doubles check 8's (or the .gitignore marker
            // check's) missing-marker report, but that state is already
            // broken and the two messages complement.
            if (half === null) {
              errors.push(
                `${rel}: the split marker line '${split.marker}' recorded in ` +
                  `${MANIFEST_NAME} is missing from the file, so managed-half ` +
                  "parity cannot be verified - restore the marker or run a " +
                  "template sync",
              );
              continue;
            }
            actual = sha256(Buffer.from(half, "latin1"));
          } else {
            actual = sha256(Buffer.from(content, "latin1"));
          }
        }
        if (actual !== hash) {
          errors.push(
            `${rel}: ${split !== null ? "its managed half does" : "content does"} ` +
              `not match the sha256 recorded in ${MANIFEST_NAME} - the file ` +
              "drifted from the last stamped sync state; local edits to " +
              `${split !== null ? "the managed half" : "a managed file"} are ` +
              "replaced by the next template sync (move them to a repo-owned " +
              "location), and intended template-side updates restamp on that sync",
          );
        }
      }
    }
  }

  writeFindings(errors, advisories);
  for (const advisory of advisories) console.log(`advisory: ${advisory}`);
  if (errors.length > 0) {
    for (const error of errors) console.error(`error: ${error}`);
    console.error(`\n${errors.length} error(s).`);
    return 1;
  }
  console.log("Validation passed.");
  return 0;
}

process.exit(main());
