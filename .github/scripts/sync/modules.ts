// Module selection for the push sync: reads a managed repo's module list
// from its .repo-platform.yml and checks it against the module choices of
// the template ref being applied, so `copier update` never receives a name
// the selected template version does not know.
//
// Usage:
//   bun .github/scripts/sync/modules.ts --repo-file <.repo-platform.yml>
//     --template-copier <copier.yml>
//
// Prints the selection as a JSON array on stdout. An unknown name is an
// error - silently dropping a typo would strip that module's files from
// the repo, and a name the template retired is a migration ladder rung's
// job (docs/migrations.md), never a tolerance here. Malformed input never
// degrades to an empty list for the same reason. Errors print as ::error:: workflow commands (on stdout,
// where the runner parses them) and the exit code is nonzero. The CLI
// stays for ci/upgrade_path_test.sh; the sync itself imports the pure
// functions (sync/select_modules.ts).

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { parseFlags } from "../shared/flags.ts";
import { fail } from "../shared/gha.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readModules(
  data: unknown,
  label = ".repo-platform.yml",
): { modules: string[] | null; errors: string[] } {
  if (!isPlainObject(data)) {
    return { modules: null, errors: [`${label}: top level must be a mapping`] };
  }
  const raw: unknown = data.modules;
  const key = "modules";
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

// The selection checked against the template ref's choices: every name
// must be one, or it is an error.
export function filterModules(
  modules: string[],
  choices: ReadonlySet<string>,
): { kept: string[]; errors: string[] } {
  const errors = modules
    .filter((name) => !choices.has(name))
    .map(
      (name) =>
        `module "${name}" is not a choice of the selected template version - fix the ` +
        `\`modules\` list in .repo-platform.yml (silently dropping it would remove that ` +
        `module's files from the repo; a name the template retired is dropped by its ` +
        `migration rung on the next sync)`,
    );
  return { kept: errors.length === 0 ? modules : [], errors };
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

function main(args: string[]): void {
  const flags = parseFlags(args, ["--repo-file", "--template-copier"]);
  const repoFile = flags["--repo-file"];
  const copierFile = flags["--template-copier"];

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

  const { kept, errors } = filterModules(modules, choices);
  if (errors.length > 0) {
    fail(errors.map((message) => `${repoFile}: ${message}`));
  }
  console.log(JSON.stringify(kept));
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
