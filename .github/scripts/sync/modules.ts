// Module selection for the push sync: reads a managed repo's module list
// from its .repo-platform.yml and checks it against the module choices of
// the template ref being applied, so `copier update` never receives a name
// the selected template version does not know. The registration grammar
// itself lives with the plan action (actions/plan/registration.ts), the
// one home every reader imports it from.
//
// Usage:
//   bun .github/scripts/sync/modules.ts --repo-file <.repo-platform.yml>
//     --template-copier <copier.yml>
//
// Prints the selection as a JSON array on stdout. An unknown name is an error
// (dropping a typo would strip a module's files; a retired name is a ladder
// rung's job, docs/migrations.md), and malformed input never reads as empty.
// Errors print as ::error:: workflow commands (on stdout, where the runner
// parses them) and the exit code is nonzero. The CLI stays for the
// upgrade-path harness (tests/ci/upgrade_path/); the sync itself imports the
// pure functions (sync/select_modules.ts).

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  declaredModules,
  readModuleOrder,
  readModules,
} from "../../../actions/plan/registration.ts";
import { parseFlags } from "../shared/flags.ts";
import { fail } from "../shared/gha.ts";

export { declaredModules, readModules };

/** The module choice values of parsed copier.yml data, as the set the
 *  selection is filtered against. */
export function readModuleChoices(
  data: unknown,
  label = "copier.yml",
): { choices: Set<string> | null; errors: string[] } {
  const order = readModuleOrder(data, label);
  return { choices: order.choices === null ? null : new Set(order.choices), errors: order.errors };
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
