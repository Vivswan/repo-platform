import { join } from "node:path";
import type { Context } from "../context.ts";
import { advisory, error, type Finding } from "../findings.ts";
import { pathExists } from "../readers.ts";

/** One license file per repo. GitHub, registries, and the fleet sync all
 *  pick a single license: LICENSE next to LICENSE.md means a stale spelling
 *  survived the rename or a custom license collided with the fleet one.
 *  Presence, not regular-file-ness, so a symlinked license still counts. */
export function checkLicense(ctx: Context): Finding[] {
  const spellings = ["LICENSE", "LICENSE.md"].filter((name) => pathExists(join(ctx.root, name)));
  if (spellings.length > 1) {
    return [
      error(
        "LICENSE and LICENSE.md both exist - a repo must not carry both " +
          "spellings; keep the current license (fleet repos: LICENSE.md) " +
          "and delete the other (git history remains the record of prior " +
          "licensing; third-party notices can move below the license's " +
          "END marker)",
      ),
    ];
  }
  if (spellings[0] === "LICENSE") {
    return [
      advisory(
        "LICENSE: the fleet convention is LICENSE.md for every repo, custom " +
          "licenses included - rename it (GitHub detects both spellings)",
      ),
    ];
  }
  return [];
}
