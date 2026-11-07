// A shipped source as the writer renders it for the platform owner with no block spliced: the owner placeholder
// substituted and the `{{blocks}}` anchor line gone, so a template parses as the YAML the fleet receives.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spliceBlocks, substitute } from "../../.github/scripts/sync/writer/placeholders.ts";
import { PLATFORM_OWNER } from "../../actions/shared/platform.ts";

const ROOT = join(import.meta.dir, "../..");

/** The file at `rel` under the repository root, rendered with `{{github_username}}` the platform owner and no blocks. */
export function shippedText(rel: string): string {
  const text = readFileSync(join(ROOT, rel), "utf8");
  return substitute(spliceBlocks(text, []), { github_username: PLATFORM_OWNER });
}
