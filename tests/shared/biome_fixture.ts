// A linter rule's bite test: fixture files judged by the repository's own biome configuration and plugins, in a tree of
// their own, so a rule is seen firing on an offender no real file is.

import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { boundedSpawnSync } from "./bounded_spawn.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** One diagnostic of a fixture run. */
export interface FixtureDiagnostic {
  /** The rule's category: `plugin` for every grit plugin, a `lint/...` name for a built-in rule. */
  category: string;

  /** The fixture file, relative to the lint root. */
  path: string;

  /** The line the diagnostic starts on. */
  line: number;

  /** The rule's own words, which tell one grit plugin from another. */
  message: string;
}

/** Every diagnostic biome reports for `files` under the repository's lint configuration.
 *
 * @param lintRoot - an empty directory the caller owns and removes
 * @param files - the fixture files by path relative to the lint root, placed as the configuration's globs expect
 */
export function lintFixture(lintRoot: string, files: Record<string, string>): FixtureDiagnostic[] {
  for (const config of ["biome.json", "biome.local.jsonc", "biome"]) {
    cpSync(join(REPO_ROOT, config), join(lintRoot, config), { recursive: true });
  }
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(lintRoot, rel)), { recursive: true });
    writeFileSync(join(lintRoot, rel), content);
  }

  const ran = boundedSpawnSync(
    [
      join(REPO_ROOT, "node_modules", ".bin", "biome"),
      "lint",
      "--reporter=json",
      "--vcs-enabled=false",
      ".",
    ],
    { cwd: lintRoot },
  );
  const report = JSON.parse(ran.stdout) as {
    diagnostics: {
      category: string;
      message: string;
      location: { path: string; start: { line: number } };
    }[];
  };

  return report.diagnostics.map((d) => ({
    category: d.category,
    path: d.location.path,
    line: d.location.start.line,
    message: d.message,
  }));
}
