import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { error, type Finding } from "../findings.ts";
import { hasConflictMarker, isRecord, isRegularFile } from "../readers.ts";

const CONFIG_PATH = "release-please-config.json";

/** No `release-as` pin in release-please-config.json, at the top level or
 *  in any package: release-please never strips the pin after the pinned
 *  release ships, so the NEXT release PR proposes the same version again
 *  (and with force-tag-creation would move the published tag). A version
 *  is forced once with a `Release-As: x.y.z` commit footer instead.
 *  Presence-gated, not module-gated: the file is a repo-owned starter, so
 *  it is the file, not the module selection, that can carry the pin. */
export function checkReleasePlease(ctx: Context): Finding[] {
  const path = join(ctx.root, CONFIG_PATH);
  if (!isRegularFile(path)) return [];
  const text = readFileSync(path, "utf-8");
  // A conflict-marked config is the conflict-marker check's report; parsing
  // it here would only add a second, noisier diagnostic for the same damage.
  if (hasConflictMarker(text)) return [];
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch (exc) {
    return [
      error(
        `${CONFIG_PATH}: not valid JSON (${exc instanceof Error ? exc.message.split("\n")[0] : String(exc)})`,
      ),
    ];
  }
  if (!isRecord(config)) return [];
  const pinned: string[] = [];
  if ("release-as" in config) pinned.push("the top level");
  if (isRecord(config.packages)) {
    for (const [name, pkg] of Object.entries(config.packages)) {
      if (isRecord(pkg) && "release-as" in pkg) pinned.push(`package "${name}"`);
    }
  }
  if (pinned.length === 0) return [];
  return [
    error(
      `${CONFIG_PATH} pins a version with release-as at ${pinned.join(" and ")}: ` +
        "release-please never removes the pin after that release ships, so the next release PR " +
        "proposes the same version again (and force-tag-creation would move the published tag). " +
        "Delete the key; to force a version once, merge an empty commit carrying a footer: " +
        'git commit --allow-empty -m "chore: release 5.0.0" -m "Release-As: 5.0.0"',
    ),
  ];
}
