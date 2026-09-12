// The one assembly of a sourced entry's text: the writer and the parity rule (scripts/check/ssot/twin_copies.ts)
// share this render, so the copy the rule holds a root file to is the writer's own, not a second reading.

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

type SourcedEntry = ManagedEntry | StarterEntry | SplitEntry;

/** A placeholder without a value stops the render: an empty value is never written. */
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
