// A source under files/ as a target receives it, rendered by the writer's own functions, for tests that parse a
// shipped workflow: a placeholder a test filled by hand parses as a YAML flow mapping the day the source gains another.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadFilesConfig } from "../../.github/scripts/sync/writer/files_config.ts";
import { spliceBlocks, substitute } from "../../.github/scripts/sync/writer/placeholders.ts";
import { placeholderValues } from "../../.github/scripts/sync/writer/registration.ts";
import { PLATFORM_OWNER } from "../../actions/shared/platform.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const REGISTRATION = {
  modules: [],
  project: { name: "Demo", slug: "demo", description: "A demo" },
};
const VALUES = placeholderValues(
  REGISTRATION,
  { owner: PLATFORM_OWNER, name: "demo" },
  false,
  loadFilesConfig(join(REPO_ROOT, "files.yml"), join(REPO_ROOT, "files")).defaults,
);

/** The text with no module block spliced at its `{{blocks}}` line and every placeholder filled for a public demo
 *  repository of the platform's owner.
 *
 *  @throws {Error} the text names a placeholder the writer does not derive
 */
export function rendered(text: string): string {
  return substitute(spliceBlocks(text, []), VALUES);
}

/** The repository file at `rel`, rendered: a file that is no source holds no placeholder and reads as written. */
export function shippedSource(rel: string): string {
  return rendered(readFileSync(join(REPO_ROOT, rel), "utf8"));
}
