#!/usr/bin/env bun
// Validate a repo generated/managed by Vivswan/repo-platform.
//
// Checks (errors fail the run):
//   1. .copier-answers.yml and .repo-platform.yml exist, the latter records
//      a valid top-level `modules` list, and the former pins a well-formed
//      `github_username` (the owner whose composite actions ci.yml must use)
//   2. .gitignore managed/local marker sections appear exactly once
//   3. Every .yml/.yaml file parses; duplicate mapping keys are errors
//      under .github/ and in the registration files, advisories elsewhere
//   4. No unresolved merge-conflict markers in text files
//   5. .github/workflows/ci.yml exists (the template always generates and
//      manages it), an `all-green` job exists with `if: always()`, a step
//      failing on any non-success result, and `needs:` listing every other
//      job, and the typography check renders for the shape: a `typography`
//      job on public renders, an unconditional check-typography step inside
//      `base-checks` on private renders (which merge the base checks there)
//   6. LICENSE and LICENSE.md never coexist - a repo carries exactly one
//      license file
//   7. Every selected toolchain module with a version pin carries its
//      managed version dotfile with exactly the pinned version
//   8. Sync-managed files self-declare their ownership: files sync wholly
//      overwrites open with the managed header naming the pinned owner, and
//      split files (a managed top above a repo-owned tail) carry the
//      repo-platform:local-section marker exactly once. Existing files
//      only - absence is damage the next sync heals - and _skip_if_exists
//      starters are exempt (repo-owned after the first render)
//   9. Ownership-manifest byte parity: .repo-platform-manifest.json (the
//      template-rendered ownership map, hashes and the render's _commit
//      provenance stamped post-render by the template's stamp_manifest.ts
//      hook) is well-formed, its own entry stays hash-null (a self-hash
//      would be circular - the content includes every other hash), its
//      class metadata agrees with this validator's own ownership tables
//      for every path they cover (sync baselines local manifest edits, so
//      a hand-flipped class would otherwise disable parity permanently),
//      and every managed or split entry's recorded sha256 matches the file
//      on disk (split files: the managed half alone, delimited by the
//      entry's marker line). Drift means the file changed since the last
//      stamp; the next sync replaces it. A non-null provenance stamp must
//      equal the recorded _commit on every channel. ABSENCE is judged by
//      alignment: a templates/vX.Y.Z-form recorded _commit proves version
//      alignment (see the check's trust-model comment), making a missing
//      manifest, a null provenance stamp, and a missing roster entry whose
//      file still exists hard errors there - the latter only while the
//      executing ref (VALIDATOR_REF) is the render's version; unaligned
//      renders (staging, legacy) get skew-mode advisories instead. A
//      listed file missing from the repo stays an advisory (check 8's
//      absence stance - the withheld-workflows push path leaves those
//      legitimately); a conflict-marked manifest is left to check 4's
//      report.
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
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { parseAllDocuments, parse as parseYaml } from "yaml";

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

const MARKER_FILES: Record<string, string[]> = {
  ".gitignore": [
    "# BEGIN REPOSITORY LOCAL",
    "# END REPOSITORY LOCAL",
    "# BEGIN REPO-PLATFORM MANAGED",
    "# END REPO-PLATFORM MANAGED",
  ],
};

/** The line splitting a file's sync-managed top from its repo-owned tail;
 *  ownership check 8 requires it exactly once in split files, matched as
 *  its exact comment lines (a substring mention must not count). */
const LOCAL_SECTION_MARKER = "repo-platform:local-section";
const LOCAL_SECTION_LINES = new Set([
  `# ${LOCAL_SECTION_MARKER}`,
  `<!-- ${LOCAL_SECTION_MARKER} -->`,
]);

/** How many opening lines may hold the managed header (rendering collapses
 *  the templates' jinja preambles, so it always lands near the top). */
const HEADER_WINDOW = 10;

/** The ownership manifest the template renders into every repo: the full
 *  ownership map (path -> managed/split/starter, marker metadata for
 *  splits) with per-repo sha256 hashes stamped post-render. Check 9
 *  verifies byte parity against it. */
const MANIFEST_NAME = ".repo-platform-manifest.json";

/** A split entry's managed half: through the first marker line's newline
 *  for managed "above", from the start of the marker line for "below";
 *  null when the marker line is missing. `content` is latin1 text
 *  (byte-faithful). Twin of stamp_manifest.ts's managedHalf - keep them
 *  matching (this action stays self-contained for client-side execution). */
function managedHalf(content: string, marker: string, managed: "above" | "below"): string | null {
  let offset = 0;
  for (const line of content.split("\n")) {
    const end = offset + line.length;
    if (line.trim() === marker) {
      return managed === "above"
        ? content.slice(0, Math.min(end + 1, content.length))
        : content.slice(offset);
    }
    offset = end + 1;
  }
  return null;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Unconditionally rendered base files and how each declares its ownership:
 *  "header" files are wholly overwritten by sync and open with the managed
 *  header; "marker" files keep a repo-owned tail below the local-section
 *  marker. Conditionally rendered base files (CODE_OF_CONDUCT.md,
 *  CONTRIBUTING.md, LICENSE.md) join in check 8 under the same
 *  answers/modules conditions that gate their rendering; module files come
 *  from the generated MODULE_OWNERSHIP record below. */
const BASE_OWNERSHIP: Record<string, "header" | "marker"> = {
  ".copier-answers.yml": "header",
  ".repo-platform.yml": "header",
  ".yamllint": "header",
  ".typography-allow": "header",
  ".github/dependabot.yml": "header",
  ".github/workflows/ci.yml": "header",
  ".editorconfig": "marker",
  ".gitattributes": "marker",
  ".github/CODEOWNERS": "marker",
  "SECURITY.md": "marker",
};

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
    yamllint: (step) => typeof step.run === "string" && step.run.includes("yamllint"),
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
  bun: { file: ".bun-version", version: "1.3.14" },
  node: { file: ".node-version", version: "24.19.0" },
  deno: { file: ".dvmrc", version: "2.9.5" },
};
// END GENERATED: toolchain-pins

// How each rendered module file declares its ownership while its module is
// selected: "header" files open with the managed header, "marker" files
// split a managed top from a repo-owned tail (scanned fail-closed by
// moduleOwnershipFiles in scripts/generate.ts - starters and comment-free
// formats stay out).
// BEGIN GENERATED: module-ownership (scripts/generate.ts - edit the module templates and copier.yml's _skip_if_exists, not this block)
const MODULE_OWNERSHIP: Record<string, { path: string; kind: "header" | "marker" }[]> = {
  agents: [{ path: "AGENTS.md", kind: "marker" }],
  bun: [{ path: ".github/workflows/dependabot-bun-lockfile.yml", kind: "header" }],
  deno: [{ path: ".github/workflows/deno-audit.yml", kind: "header" }],
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
            "'copier copy gh:Vivswan/repo-platform . --vcs-ref staging' (or a templates/vX.Y.Z tag)",
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

  // 2. Marker sections exactly once (.gitignore is always generated by the
  // template - absence means the repo is damaged, not unconfigured)
  for (const [rel, markers] of Object.entries(MARKER_FILES)) {
    const path = join(root, rel);
    if (!isRegularFile(path)) {
      errors.push(
        `${rel} is missing - the template always generates it, so the repo ` +
          "is damaged; restore the file from git history or run a template sync",
      );
      continue;
    }
    const content = readFileSync(path).toString("utf-8");
    for (const marker of markers) {
      const count = content.split(marker).length - 1;
      if (count !== 1) {
        errors.push(
          `${rel}: marker '${marker}' appears ${count} times (expected 1) - ` +
            "a merge or manual edit broke the managed sections; restore one " +
            "LOCAL section followed by one MANAGED section",
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

  // 5. all-green convention in ci.yml. The file is template-managed and
  // always generated (repo-specific jobs live in the repo-owned checks.yml
  // it calls), so a missing ci.yml means the repo is damaged.
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
        errors.push(
          "ci.yml: no `all-green` job - branch protection gates on that " +
            "single required check; add an all-green job whose `needs:` " +
            "lists every other job",
        );
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
        // Informational jobs that run alongside the gate without gating:
        // validate-template flags convention drift in managed repos but
        // must never block their merges (the next sync PR heals drift).
        const informational = new Set(["validate-template"]);
        const missing = Object.keys(jobs)
          .filter(
            (name) =>
              name !== "all-green" &&
              !downstream.has(name) &&
              !informational.has(name) &&
              !needs.includes(name),
          )
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
      const shape =
        "base-checks" in jobs
          ? ({ kind: "private-merged", steps: jobSteps(jobs["base-checks"]) } as const)
          : ({ kind: "public-fanout" } as const);
      if (shape.kind === "private-merged") {
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
      for (const advisory of ADVISORY_JOBS) {
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
  // the unconditional base table plus the conditionally rendered base files
  // and the selected modules' generated entries, under the same
  // answers/modules conditions as their templates' filename gates (a null
  // modules list stands the module-gated entries down - check 1 already
  // errored). Check 8 enforces the in-file declarations over it; check 9
  // cross-checks the manifest's class metadata against it.
  const declaredOwnership: { rel: string; kind: "header" | "marker" }[] = Object.entries(
    BASE_OWNERSHIP,
  ).map(([rel, kind]) => ({ rel, kind }));
  if (!isPrivateRender) {
    declaredOwnership.push({ rel: "CODE_OF_CONDUCT.md", kind: "header" });
    declaredOwnership.push({ rel: "CONTRIBUTING.md", kind: "marker" });
  }
  if (selectedModules !== null) {
    if (!selectedModules.includes("custom-license")) {
      declaredOwnership.push({ rel: "LICENSE.md", kind: "marker" });
    }
    for (const module of selectedModules) {
      for (const entry of MODULE_OWNERSHIP[module] ?? []) {
        declaredOwnership.push({ rel: entry.path, kind: entry.kind });
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
    // Anchored on the C1 line's canonical trailing period with no repo-name
    // character (GitHub allows [A-Za-z0-9._-]) after it, so neither a
    // negated look-alike ("is not managed by") nor a longer repo name
    // ("/repo-platform_fork", "/repo-platform.fork") counts.
    const headerRe = new RegExp(
      `This file is managed by ${ownerPin.owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` +
        "/repo-platform\\.(?![A-Za-z0-9._-])",
    );
    for (const { rel, kind } of declaredOwnership) {
      const path = join(root, rel);
      if (!isRegularFile(path)) continue;
      const content = readFileSync(path, "utf-8");
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
        const count = content
          .split("\n")
          .filter((line) => LOCAL_SECTION_LINES.has(line.trim())).length;
        if (count !== 1) {
          errors.push(
            `${rel}: the '${LOCAL_SECTION_MARKER}' marker line appears ${count} ` +
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
  // validator's version-aligned tables cover (declaredOwnership above,
  // plus .gitignore's marker grammar): the sync BASELINES non-conflicting
  // local manifest edits rather than healing them, so a hand-flipped class
  // (managed -> starter) would otherwise disable parity for that path
  // permanently and invisibly. A class or split-metadata mismatch, or an
  // entry whose render condition is off, is an error. ABSENCE (a missing
  // manifest, or a roster path the manifest fails to list) is judged by
  // PROVENANCE: the stamper writes the render's recorded _commit into the
  // self entry, and a templates/vX.Y.Z-form _commit proves version
  // alignment by the fleet's own wiring - the client validator ref and the
  // manifest ride the same render, and every templates/vX.Y.Z release ever
  // cut ships the manifest (it landed before the first release). A
  // non-null provenance stamp must equal the recorded _commit on EVERY
  // channel (the stamper writes exactly that value; a difference or a
  // deleted _commit key is tampering or a failed stamp). Aligned, absence
  // can only be deletion or damage: a missing manifest, a missing roster
  // entry whose file still exists, and a null provenance stamp (the
  // downgrade that would fake skew) are all errors - with strictness
  // additionally standing down when the executing ref (VALIDATOR_REF from
  // action.yml) is not the render's version. Unaligned (staging pins main,
  // so this validator's tables may be NEWER than the render; legacy
  // main-history _commit forms too), absence stays an advisory that names
  // the skew reason - and the strict deletion error additionally requires
  // the missing entry's FILE to still exist (see reportUnlisted). The
  // alignment signal itself (.copier-answers.yml's _commit) is
  // client-editable: rewriting it to a sha form fakes skew mode, and no
  // in-repo signal can be tamper-proof against the repo's own owner (who
  // can as easily drop the validate-template job). The guarantee is
  // therefore VISIBILITY, not prevention: every absence still surfaces as
  // a named advisory on every run, and a tampered _commit both self-heals
  // on the next sync (template and local change the same line, and
  // conflicts resolve toward the template) and breaks the repo's own
  // update base loudly. Paths beyond the tables (starters, version pins -
  // check 7 pins their bytes - and symlinks) remain manifest-trusted, an
  // accepted residue of the informational stance.
  // The _commit read must mirror sync/answers_file.ts's failsafe-schema
  // read: PyYAML (copier's writer) dumps exponent-shaped shas like
  // 95e1875 UNQUOTED (its float pattern needs a dot or signed exponent),
  // while the yaml package's core schema resolves digits-e-digits to a
  // float - a typed read turns ~2% of staging shas into Infinity and a
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
  const releaseAligned =
    answersCommit !== null && /^templates\/v\d+\.\d+\.\d+$/.test(answersCommit);
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
    if (releaseAligned) {
      errors.push(
        `${MANIFEST_NAME} is missing, but the recorded render (${answersCommit}) ` +
          "is a release that ships it (every templates/vX.Y.Z release does) - " +
          "deletion or damage; restore it from git history or run a recovery " +
          "sync (recover=recopy)",
      );
    } else {
      advisories.push(
        `${MANIFEST_NAME} is missing - this render is not pinned at a ` +
          "templates/vX.Y.Z release, so it may simply predate the ownership " +
          "manifest; a sync to a version that ships it adds the file",
      );
    }
  } else {
    const manifestText = readFileSync(manifestPath, "utf-8");
    let manifestFiles: Record<string, unknown> | null = null;
    if (!hasConflictMarker(manifestText)) {
      try {
        const manifest = JSON.parse(manifestText) as { files?: unknown };
        if (
          typeof manifest.files !== "object" ||
          manifest.files === null ||
          Array.isArray(manifest.files)
        ) {
          throw new Error("no top-level 'files' mapping");
        }
        manifestFiles = manifest.files as Record<string, unknown>;
      } catch (exc) {
        errors.push(
          `${MANIFEST_NAME}: does not parse as an ownership manifest ` +
            `(${exc instanceof Error ? exc.message.split("\n")[0] : String(exc)}); ` +
            "the file is managed - run a template sync to regenerate it",
        );
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
      // every path they cover. Shape problems on an entry are the
      // structural loop's report, not doubled here.
      const asEntry = (raw: unknown): Record<string, unknown> | null =>
        typeof raw === "object" && raw !== null && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
      // Provenance: the stamped commit on the self entry. A NON-NULL stamp
      // must equal the recorded answers _commit on every channel - the
      // stamper always writes the value it reads there, so any difference
      // (including a deleted _commit key) is tampering or a failed stamp.
      // Strict absence additionally needs a release-form match AND, when
      // the executing ref is known (VALIDATOR_REF from action.yml), that
      // ref to BE the render's version - withheld workflow files leave a
      // stale pinned validator behind whose tables legitimately disagree
      // with a newer manifest. Null stamps on unaligned renders are the
      // legacy/local skew path.
      const rawSelfCommit = asEntry(manifestFiles[MANIFEST_NAME])?.commit;
      const manifestCommit = typeof rawSelfCommit === "string" ? rawSelfCommit : null;
      const validatorRef = (process.env.VALIDATOR_REF ?? "").trim();
      const validatorRefAligned =
        validatorRef === "" ||
        validatorRef === answersCommit ||
        `templates/${validatorRef}` === answersCommit;
      let strictAbsence = false;
      let skewReason =
        "the render is not pinned at a templates/vX.Y.Z release and this " +
        "validator's tables may be newer than it";
      if (manifestCommit !== null && manifestCommit !== answersCommit) {
        errors.push(
          `${MANIFEST_NAME}: its stamped provenance (self-entry commit ` +
            `'${manifestCommit}') does not match the recorded render ` +
            `${answersCommit === null ? "(no _commit in .copier-answers.yml)" : answersCommit} - ` +
            "the stamper always writes the recorded value, so this is " +
            "tampering or a failed stamp; revert the edit or run a recovery " +
            "sync (recover=recopy)",
        );
        // The absence checks stay lenient under an already-reported
        // provenance error; no second diagnostic per missing entry.
        skewReason = "its provenance stamp is unusable (error above)";
      } else if (releaseAligned) {
        if (manifestCommit === null) {
          errors.push(
            `${MANIFEST_NAME}: its provenance stamp is null but the recorded ` +
              `render (${answersCommit}) is a release, whose stamper always ` +
              "writes it - tampering or a failed stamp; revert the edit or " +
              "run a recovery sync (recover=recopy)",
          );
          skewReason = "its provenance stamp is unusable (error above)";
        } else if (validatorRefAligned) {
          strictAbsence = true;
        } else {
          skewReason =
            `this validator runs at ref '${validatorRef}', not the render's ` +
            "version (a withheld-workflows sync leaves the pinned ref behind)";
        }
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
        // file lives on for quiet editing. An absent file under alignment
        // is a version split the fleet legitimately produces (withheld
        // workflow files pin an older ci.yml validator ref; a channel
        // switch can leave a main validator ahead of the render), where a
        // retired or not-yet-delivered table path has no file - erroring
        // there would be false.
        if (strictAbsence && fileExists) {
          errors.push(
            `${MANIFEST_NAME} does not list '${rel}', which ${declaredBy} - the ` +
              `stamper writes every entry of its version (${answersCommit}), so ` +
              "the entry was deleted by hand, and sync baselines manifest edits; " +
              "revert it (git history has the stamped original) or run a " +
              "recovery sync (recover=recopy)",
          );
        } else {
          advisories.push(
            `${MANIFEST_NAME} does not list '${rel}', which ${declaredBy} - ` +
              `${
                strictAbsence
                  ? "the path is absent from the repo too, so this is a retired " +
                    "or not-yet-delivered path seen by a validator of a " +
                    "different version, not stealth drift"
                  : `skew mode: ${skewReason}, so this may be version skew rather than deletion`
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
      for (const { rel, kind } of declaredOwnership) {
        const raw = manifestFiles[rel];
        if (raw === undefined) {
          reportUnlisted(rel, "this validator's ownership tables declare");
          continue;
        }
        const entry = asEntry(raw);
        if (entry === null) continue;
        const declared = kind === "header" ? "managed" : "split";
        if (entry.class !== declared) {
          metadataError(rel, `claims class ${JSON.stringify(entry.class)}`, declared);
          continue;
        }
        if (
          kind === "marker" &&
          (entry.managed !== "above" ||
            typeof entry.marker !== "string" ||
            !LOCAL_SECTION_LINES.has(entry.marker))
        ) {
          metadataError(
            rel,
            "carries split metadata outside the local-section grammar",
            "split with the managed half above a sentinel marker line",
          );
        }
      }
      // .gitignore has its own split grammar (the LOCAL section sits above
      // the managed one), known to this validator via MARKER_FILES.
      {
        const raw = manifestFiles[".gitignore"];
        if (raw === undefined) {
          reportUnlisted(".gitignore", "the template always renders");
        } else {
          const entry = asEntry(raw);
          if (
            entry !== null &&
            (entry.class !== "split" ||
              entry.marker !== "# BEGIN REPO-PLATFORM MANAGED" ||
              entry.managed !== "below")
          ) {
            metadataError(
              ".gitignore",
              "does not match the managed-section grammar",
              'split with the managed half below "# BEGIN REPO-PLATFORM MANAGED"',
            );
          }
        }
      }
      // An entry for a table-covered path whose render condition is off
      // (an unselected module's workflow, a public-only file on a private
      // render) cannot come from the template; it is manifest drift.
      const expectedPaths = new Set(declaredOwnership.map((f) => f.rel));
      const coveredEver = new Set<string>([
        ...Object.keys(BASE_OWNERSHIP),
        "CODE_OF_CONDUCT.md",
        "CONTRIBUTING.md",
        ...(selectedModules !== null
          ? ["LICENSE.md", ...Object.values(MODULE_OWNERSHIP).flatMap((e) => e.map((f) => f.path))]
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
      for (const [rel, raw] of Object.entries(manifestFiles)) {
        const where = `${MANIFEST_NAME}: entry '${rel}'`;
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
          errors.push(`${where} is not an object; run a template sync to regenerate the manifest`);
          continue;
        }
        const entry = raw as Record<string, unknown>;
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
        if (entry.class !== "managed" && entry.class !== "split") {
          errors.push(
            `${where} has unknown class ${JSON.stringify(entry.class)} (expected ` +
              "managed, split, or starter); run a template sync to regenerate the manifest",
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
