// Preflight validation of central settings files against their repos'
// actual module selections. The apply deletes undeclared labels, so a
// settings/repos/<name>.yml missing a label its repo's modules need
// (dependabot's per-ecosystem defaults, release-please's autorelease pair,
// the fuzzer tracking label) starts a silent nightly loop: the apply
// deletes the label, the tool recreates it, every run stays green. Module
// selection lives in each target repo's own .repo-platform.yml and its
// fuzzer label in its .copier-answers.yml, so the label comparison cannot
// run offline - settings-repos.yml invokes this with the fleet PAT before
// the apply.
//
// Usage:
//   bun .github/scripts/fleet/validate_central_settings.ts --owner Vivswan
//     [--dir settings/repos]
//
// Local checks (the file parses, the identity keys are declared, the
// label roster is well-formed) run first and never touch the network; the
// remote module comparison runs only for files that declare a labels
// section - an undeclared section is never applied, so there is nothing
// to compare and no reason for an API hiccup to block the run. A target
// repo without .repo-platform.yml is the existing not-registered case: a
// ::warning::, not a failure. Everything else that blocks validation, and
// every missing label, is reported as ::error:: - all of them at once -
// and the exit code is nonzero.

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { parseFlags } from "../shared/flags.ts";

export interface CheckResult {
  errors: string[];
  warnings: string[];
}

export type Fetched =
  | { status: "ok"; text: string }
  | { status: "missing" }
  | { status: "failed"; detail: string };

// The per-ecosystem labels dependabot puts on its PRs (and recreates when
// missing), keyed by the toolchain module that enables the ecosystem.
// Values match templates/settings-sync/.github/settings.yml.jinja.
const TOOLCHAIN_LABELS: [module: string, label: string][] = [
  ["bun", "javascript"],
  ["uv", "python:uv"],
  ["rust", "rust"],
];

/** The label names a repo's settings file must declare so the apply's
 *  delete-undeclared pass does not fight the tools that recreate them. */
export function requiredLabels(
  modules: string[],
  fuzzerLabel: string,
): { name: string; why: string }[] {
  const required = [
    // The base dependabot.yml always carries the github-actions ecosystem,
    // so these two are unconditional.
    { name: "dependencies", why: "dependabot puts it on every PR" },
    { name: "github_actions", why: "the github-actions dependabot ecosystem is unconditional" },
  ];
  for (const [module, name] of TOOLCHAIN_LABELS) {
    if (modules.includes(module)) {
      required.push({ name, why: `the ${module} module's dependabot PRs carry it` });
    }
  }
  if (modules.includes("release-please")) {
    for (const name of ["autorelease: pending", "autorelease: tagged"]) {
      required.push({ name, why: "release-please manages it on release PRs" });
    }
  }
  if (modules.includes("fuzzer")) {
    required.push({
      name: fuzzerLabel,
      why: "the fuzzer module's tracking issue keys on it (stripping it breaks the auto-close)",
    });
  }
  return required;
}

export interface IdentityIssue {
  key: string;
  expected: string;
  got: string;
}

/** The repository identity keys the settings-sync template renders
 *  unconditionally for module repos (description, homepage, topics,
 *  private) - the apply never touches an undeclared key, so a central
 *  file must declare all four or their out-of-band drift is never healed.
 *  check_ssot.ts's settings-blocks rule shares this list for
 *  repo-platform's own file. */
export function centralIdentityIssues(repository: Record<string, unknown>): IdentityIssue[] {
  const issues: IdentityIssue[] = [];
  const got = (value: unknown) => (value === undefined ? "missing" : JSON.stringify(value));
  if (typeof repository.description !== "string" || repository.description === "") {
    issues.push({
      key: "description",
      expected: "a non-empty description string",
      got: got(repository.description),
    });
  }
  if (typeof repository.homepage !== "string") {
    issues.push({
      key: "homepage",
      expected: 'a homepage string ("" declares-and-clears)',
      got: got(repository.homepage),
    });
  }
  const topics = repository.topics;
  if (
    typeof topics !== "string" &&
    !(Array.isArray(topics) && topics.every((t) => typeof t === "string"))
  ) {
    issues.push({
      key: "topics",
      expected: "a declared topics value (string or string list)",
      got: got(topics),
    });
  }
  if (typeof repository.private !== "boolean") {
    issues.push({
      key: "private",
      expected: "an explicit boolean, so the apply manages visibility",
      got: got(repository.private),
    });
  }
  return issues;
}

function parseMapping(text: string, where: string): Record<string, unknown> | string {
  let data: unknown;
  try {
    data = parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return `YAML parse error: ${detail}`;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return `${where} is not a YAML mapping`;
  }
  return data as Record<string, unknown>;
}

/** Everything checkable without network access. `declared` carries the
 *  file's label names, or null when the file has no labels section (the
 *  apply never touches an undeclared section, so there is no roster to
 *  compare against the repo's modules) or is unreadable. */
export function checkCentralFileLocal(
  file: string,
  centralText: string,
): { errors: string[]; declared: Set<string> | null } {
  const errors: string[] = [];
  const central = parseMapping(centralText, file);
  if (typeof central === "string") return { errors: [`${file}: ${central}`], declared: null };

  const repository = central.repository;
  if (typeof repository !== "object" || repository === null || Array.isArray(repository)) {
    errors.push(
      `${file}: no repository block - description, homepage, topics, and private ` +
        `must be declared, or their out-of-band drift is never healed`,
    );
  } else {
    for (const issue of centralIdentityIssues(repository as Record<string, unknown>)) {
      errors.push(
        `${file}: repository.${issue.key} - expected ${issue.expected}, got ${issue.got}`,
      );
    }
  }

  if (!("labels" in central)) return { errors, declared: null };
  if (!Array.isArray(central.labels)) {
    errors.push(`${file}: labels is not a list`);
    return { errors, declared: null };
  }
  const declared = new Set<string>();
  central.labels.forEach((entry, index) => {
    const name =
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? (entry as Record<string, unknown>).name
        : entry;
    if (typeof name === "string") {
      declared.add(name);
    } else {
      errors.push(
        `${file}: labels[${index}] has no name: - the apply cannot sync a nameless label`,
      );
    }
  });
  return { errors, declared };
}

/** The module-derived label comparison, run only for files whose local
 *  check produced a roster. `fetchFile` reads a path from the target
 *  repo's default branch (injected so tests never touch the network). */
export function checkCentralFileRemote(
  file: string,
  repo: string,
  declared: Set<string>,
  fetchFile: (path: string) => Fetched,
): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const registration = fetchFile(".repo-platform.yml");
  if (registration.status === "failed") {
    errors.push(
      `${repo}/.repo-platform.yml: fetch failed (${registration.detail}) - not a ` +
        `yes/no answer, refusing to guess`,
    );
    return { errors, warnings };
  }
  if (registration.status === "missing") {
    warnings.push(
      `${file}: the target repository carries no .repo-platform.yml (not adopted), ` +
        `so its labels cannot be checked against a module selection - adopt the ` +
        `repo, or remove the central file if it is stale`,
    );
    return { errors, warnings };
  }

  const parsed = parseMapping(registration.text, ".repo-platform.yml");
  const modules = typeof parsed === "string" ? null : parsed.modules;
  if (!Array.isArray(modules) || !modules.every((m) => typeof m === "string")) {
    errors.push(
      `${file}: the target repo's .repo-platform.yml has no readable top-level ` +
        `modules list${typeof parsed === "string" ? ` (${parsed})` : ""} - ` +
        `fix that file; the central settings cannot be validated against it`,
    );
    return { errors, warnings };
  }

  // The fuzzer label is the tracking-issue identity: guessing a default
  // here could pass while the repo's real label loops on delete/recreate,
  // so an unreadable answer is an error, never a fallback.
  let fuzzerLabel = "";
  if (modules.includes("fuzzer")) {
    const answers = fetchFile(".copier-answers.yml");
    if (answers.status === "failed") {
      errors.push(
        `${repo}/.copier-answers.yml: fetch failed (${answers.detail}) - not a ` +
          `yes/no answer, refusing to guess`,
      );
      return { errors, warnings };
    }
    const recorded =
      answers.status === "ok" ? parseMapping(answers.text, ".copier-answers.yml") : null;
    const value = recorded !== null && typeof recorded !== "string" ? recorded.fuzzer_label : null;
    if (typeof value !== "string" || value === "") {
      errors.push(
        `${file}: the target repo has the fuzzer module but no fuzzer_label answer ` +
          `is readable from its .copier-answers.yml, so the tracking label cannot ` +
          `be verified - fix the answers file`,
      );
      return { errors, warnings };
    }
    fuzzerLabel = value;
  }

  for (const { name, why } of requiredLabels(modules, fuzzerLabel)) {
    if (!declared.has(name)) {
      errors.push(
        `${file}: labels must declare ${JSON.stringify(name)} - ${why}, and the apply ` +
          `deletes undeclared labels, so leaving it out loops delete/recreate nightly; ` +
          `copy the tuple from templates/settings-sync/.github/settings.yml.jinja`,
      );
    }
  }
  return { errors, warnings };
}

function fail(errors: string[]): never {
  for (const message of errors) {
    console.error(`::error::${message}`);
  }
  process.exit(1);
}

/** Raw file content from the repo's default branch. HTTP 404 is a real
 *  answer (`missing`); anything else is `failed` and becomes an error at
 *  the call site, collected with the rest instead of aborting the scan. */
function fetchRepoFile(repo: string, path: string): Fetched {
  const proc = Bun.spawnSync([
    "gh",
    "api",
    `repos/${repo}/contents/${path}`,
    "-H",
    "Accept: application/vnd.github.raw",
  ]);
  if (proc.exitCode === 0) return { status: "ok", text: proc.stdout.toString() };
  const stderr = proc.stderr.toString();
  if (stderr.includes("HTTP 404")) return { status: "missing" };
  return { status: "failed", detail: stderr.trim().split("\n")[0] || "unknown error" };
}

function main(args: string[]): void {
  const flags = parseFlags(args, ["--owner"], ["--dir"]);
  const owner = flags["--owner"];
  const dir = flags["--dir"] ?? "settings/repos";

  // This repo's own name: its central file gets the local checks but no
  // module comparison (the operator repo is not generated from the
  // template, so it has no .repo-platform.yml to read modules from);
  // check_ssot.ts validates its label roster instead.
  const selfName = String(
    (JSON.parse(readFileSync("package.json", "utf-8")) as Record<string, unknown>).name,
  );

  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    fail([`${dir}: cannot read the central settings directory`]);
  }

  const errors: string[] = [];
  for (const entry of entries) {
    const file = join(dir, entry);
    if (entry.endsWith(".yaml")) {
      errors.push(
        `${file}: central settings files must use the .yml suffix - a .yaml file ` +
          `would silently fall outside every check keyed on <name>.yml; rename it`,
      );
      continue;
    }
    if (!entry.endsWith(".yml")) continue;

    const local = checkCentralFileLocal(file, readFileSync(file, "utf-8"));
    errors.push(...local.errors);
    const name = basename(entry, ".yml");
    if (name === selfName) {
      console.log(`${file}: identity checked; module comparison skipped (this repo)`);
      continue;
    }
    if (local.declared === null) {
      if (local.errors.length === 0) {
        console.log(`${file}: OK - no labels section, so labels stay unmanaged`);
      }
      continue;
    }
    const repo = `${owner}/${name}`;
    const remote = checkCentralFileRemote(file, repo, local.declared, (path) =>
      fetchRepoFile(repo, path),
    );
    for (const warning of remote.warnings) console.log(`::warning::${warning}`);
    errors.push(...remote.errors);
    if (local.errors.length === 0 && remote.errors.length === 0 && remote.warnings.length === 0) {
      console.log(`${file}: OK - labels cover ${repo}'s modules`);
    }
  }
  if (errors.length > 0) fail(errors);
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
