// The one assembly of a sourced entry's text: the writer renders every target's copy through here, and the
// operator's root copies are held to the same call (scripts/check/ssot/twin_copies.ts), so the file this
// repository runs and the file it ships can only be the same bytes.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  FilesConfig,
  ManagedEntry,
  SplitEntry,
  StarterEntry,
} from "../../../../actions/plan/files_config.ts";
import { blockSources } from "./files_config.ts";
import { regionMarkers } from "./manifest.ts";
import {
  missingPlaceholders,
  type PlaceholderValues,
  spliceBlocks,
  substitute,
} from "./placeholders.ts";
import { renderRegion } from "./write_split.ts";

export type SourcedEntry = ManagedEntry | StarterEntry | SplitEntry;

/** What the entry writes for one repository: the source with its blocks spliced and its placeholders
 *  substituted, wrapped in the region markers for a split entry; or the placeholders that have no value
 *  (nothing is rendered then: an empty value is never written). */
export function renderSourced(
  config: FilesConfig,
  tree: string,
  entry: SourcedEntry,
  modules: string[],
  values: PlaceholderValues,
): string | { missing: string[] } {
  const raw = (rel: string) => readFileSync(join(tree, rel), "utf-8");
  const blocks = blockSources(config, entry, modules, tree).map(raw);
  const spliced = spliceBlocks(raw(entry.source), blocks);
  const missing = missingPlaceholders(spliced, values);
  if (missing.length > 0) return { missing };
  const body = substitute(spliced, values);
  return entry.class === "split" ? renderRegion(body, regionMarkers(entry.region)) : body;
}
