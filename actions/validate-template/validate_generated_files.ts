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
//
// Advisories (printed, never fail): missing actionlint / yamllint /
// commit-names / gitleaks checks in ci.yml (older renders predate the newer
// checks) - matched as jobs on public renders and as base-checks steps on
// private ones - plus dependency-review on public renders only (private
// renders never get that job, so their answers silence the advisory);
// duplicate mapping keys in YAML outside .github/ and the registration
// files.
//
// Usage: bun actions/validate-template/validate_generated_files.ts [--self] [target-dir]
//
// --self: validate repo-platform itself. Skips the registration-file check
// (the template repo is not generated from itself, so it has no
// .copier-answers.yml / .repo-platform.yml); all other checks apply.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

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
  "pr-title",
  "auto-assign",
  "fuzzer",
  "settings-sync",
  "custom-license",
]);
// END GENERATED: known-modules

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

/** All regular files below root, sorted, skipping SKIP_DIRS. */
function walk(root: string): string[] {
  const found: string[] = [];
  const visit = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (SKIP_DIRS.has(name)) continue;
      const stat = lstatSync(join(root, childRel));
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(childRel);
      else if (stat.isFile() && !stat.isSymbolicLink()) found.push(childRel);
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
  for (const rel of walk(root)) {
    const path = join(root, rel);
    const suffix = extname(rel);
    if (suffix === ".yml" || suffix === ".yaml") {
      const text = readFileSync(path, "utf-8");
      try {
        safeLoadYaml(text);
      } catch (exc) {
        const message = exc instanceof Error ? exc.message.split("\n")[0] : String(exc);
        const syntaxError = (m: string) =>
          `${rel}: does not parse as YAML (${m}); fix the syntax at the position shown`;
        if ((exc as { code?: string }).code !== "DUPLICATE_KEY") {
          errors.push(syntaxError(message));
        } else {
          // Duplicate keys are syntactically valid YAML, so "fix the syntax"
          // would mislead; name the real problem.
          const report =
            `${rel}: duplicate mapping key (${message}) - the later value silently ` +
            "wins at consumption time; remove or rename the duplicate";
          if (isStrictYaml(rel)) {
            errors.push(report);
          } else {
            // Duplicates here are only an advisory, but re-parse tolerantly
            // so a further real syntax error (masked above because parse
            // throws its first error) still fails.
            try {
              shapeOfYaml(text);
              advisories.push(report);
            } catch (tolerantExc) {
              errors.push(
                syntaxError(
                  tolerantExc instanceof Error
                    ? tolerantExc.message.split("\n")[0]
                    : String(tolerantExc),
                ),
              );
            }
          }
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
      const answersText = hasAnswers ? readFileSync(answersPath, "utf-8") : "";
      const isPrivateRender = /^private: true\b/m.test(answersText);
      const username = (/^github_username: (.*)$/m.exec(answersText)?.[1] ?? "").trim();
      const owner: string | null = selfMode
        ? "[A-Za-z0-9-]+"
        : /^[A-Za-z0-9-]+$/.test(username)
          ? username
          : null;
      // A missing answers file already errored above; no second diagnostic
      // on the same root cause.
      if (owner === null && hasAnswers) {
        errors.push(
          ".copier-answers.yml: `github_username` is missing or not a " +
            "GitHub username - it pins which owner's composite actions " +
            "ci.yml must use; restore the field or re-run a template sync",
        );
      }
      const ownedActionFor =
        (pinned: string) =>
        (name: string): RegExp =>
          new RegExp(`^${pinned}/repo-platform/actions/${name}@`);
      // The render shape decides what the remaining checks require: a
      // base-checks job means the private merged shape (the five base
      // checks are its steps), anything else is the public fan-out.
      // Resolved once so no check mixes expectations from both shapes.
      const shape =
        "base-checks" in jobs
          ? ({ kind: "private-merged", steps: jobSteps(jobs["base-checks"]) } as const)
          : ({ kind: "public-fanout" } as const);
      if (shape.kind === "private-merged") {
        if (owner !== null) {
          const action = ownedActionFor(owner)("check-typography");
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
      const stepMarkers = owner === null ? null : mergedStepMarkers(ownedActionFor(owner));
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
