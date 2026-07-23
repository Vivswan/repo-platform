// Module selection for the push sync: reads a managed repo's module list
// from its .repo-platform.yml and filters it against the module choices of
// the template ref being applied, so `copier update` never receives a name
// the selected template version does not know.
//
// Usage:
//   bun .github/scripts/sync_modules.ts --repo-file <.repo-platform.yml>
//     --template-copier <copier.yml> [--retired-summary <file>]
//
// Prints the filtered selection as a JSON array on stdout. Retired module
// names (the RETIRED_MODULES allowlist) are dropped and written one per
// line to --retired-summary for the workflow to surface; any other unknown
// name is an error - silently dropping a typo would strip that module's
// files from the repo. Malformed input never degrades to an empty list for
// the same reason. Errors go to stderr as ::error:: workflow commands and
// the exit code is nonzero.

import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

// Modules the template has deliberately retired: a repo still listing one
// gets it dropped with a notice instead of a hard failure. Empty today;
// add the name here when retiring a module.
export const RETIRED_MODULES: ReadonlySet<string> = new Set();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Read the module list from parsed .repo-platform.yml data: the top-level
// `modules` key wins; deployed repos still carry the legacy nested
// `template.modules` shape, so that bridges until their first push sync.
export function readModules(
  data: unknown,
  label = ".repo-platform.yml",
): { modules: string[] | null; errors: string[] } {
  if (!isPlainObject(data)) {
    return { modules: null, errors: [`${label}: top level must be a mapping`] };
  }
  let raw: unknown = data.modules;
  let key = "modules";
  if (raw === undefined && isPlainObject(data.template)) {
    raw = data.template.modules;
    key = "template.modules";
  }
  if (raw === undefined) {
    return {
      modules: null,
      errors: [
        `${label}: no module selection found - add a top-level ` +
          `\`modules: [...]\` list (the sync never assumes an empty selection, ` +
          `which would strip every module from the repo)`,
      ],
    };
  }
  if (!Array.isArray(raw)) {
    return { modules: null, errors: [`${label}: ${key} must be a list of module names`] };
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  const modules: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry === "") {
      errors.push(`${label}: ${key} entry ${JSON.stringify(entry)} is not a module name`);
      continue;
    }
    if (seen.has(entry)) {
      errors.push(`${label}: duplicate ${key} entry "${entry}"`);
      continue;
    }
    seen.add(entry);
    modules.push(entry);
  }
  if (errors.length > 0) {
    return { modules: null, errors };
  }
  return { modules, errors: [] };
}

// Extract the module choice values from parsed copier.yml data.
export function readModuleChoices(
  data: unknown,
  label = "copier.yml",
): { choices: Set<string> | null; errors: string[] } {
  if (!isPlainObject(data) || !isPlainObject(data.modules)) {
    return { choices: null, errors: [`${label}: no \`modules\` question found`] };
  }
  const raw = data.modules.choices;
  const values = Array.isArray(raw) ? raw : isPlainObject(raw) ? Object.values(raw) : null;
  if (values === null || !values.every((value) => typeof value === "string" && value !== "")) {
    return {
      choices: null,
      errors: [`${label}: modules.choices must map choice labels to module-name strings`],
    };
  }
  return { choices: new Set(values), errors: [] };
}

// Split the selection into kept (known to the template ref) and retired
// (dropped with a notice); any other name is an error.
export function filterModules(
  modules: string[],
  choices: ReadonlySet<string>,
  retired: ReadonlySet<string> = RETIRED_MODULES,
): { kept: string[]; dropped: string[]; errors: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  const errors: string[] = [];
  for (const name of modules) {
    if (choices.has(name)) {
      kept.push(name);
    } else if (retired.has(name)) {
      dropped.push(name);
    } else {
      errors.push(
        `module "${name}" is not a choice of the selected template version and is ` +
          `not a retired module - fix the \`modules\` list in .repo-platform.yml ` +
          `(silently dropping it would remove that module's files from the repo)`,
      );
    }
  }
  return { kept, dropped, errors };
}

function fail(errors: string[]): never {
  for (const message of errors) {
    console.error(`::error::${message}`);
  }
  process.exit(1);
}

function parseYamlFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    fail([`${path}: cannot read the file`]);
  }
  try {
    return parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    fail([`${path}: YAML parse error: ${detail}`]);
  }
}

function parseFlags(args: string[], allowed: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!allowed.includes(flag) || value === undefined) {
      fail([`unknown or valueless argument "${flag}" - allowed flags: ${allowed.join(", ")}`]);
    }
    flags.set(flag, value);
  }
  return flags;
}

function main(args: string[]): void {
  const flags = parseFlags(args, ["--repo-file", "--template-copier", "--retired-summary"]);
  const repoFile = flags.get("--repo-file");
  const copierFile = flags.get("--template-copier");
  if (repoFile === undefined || copierFile === undefined) {
    fail(["--repo-file and --template-copier are both required"]);
  }

  const { modules, errors: moduleErrors } = readModules(parseYamlFile(repoFile), repoFile);
  if (modules === null) {
    fail(moduleErrors);
  }
  const { choices, errors: choiceErrors } = readModuleChoices(
    parseYamlFile(copierFile),
    copierFile,
  );
  if (choices === null) {
    fail(choiceErrors);
  }

  const { kept, dropped, errors } = filterModules(modules, choices);
  if (errors.length > 0) {
    fail(errors.map((message) => `${repoFile}: ${message}`));
  }
  const summaryPath = flags.get("--retired-summary");
  if (summaryPath !== undefined) {
    writeFileSync(summaryPath, dropped.map((name) => `${name}\n`).join(""));
  }
  console.log(JSON.stringify(kept));
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
