import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  blockSources,
  type FilesConfig,
  type ManagedEntry,
  type RegionKind,
  type SplitEntry,
  type StarterEntry,
  type UpstreamRef,
} from "../../../../actions/plan/files_config.ts";
import { regionMarkers } from "./manifest.ts";
import {
  missingPlaceholders,
  type PlaceholderValues,
  spliceBlocks,
  substitute,
} from "./placeholders.ts";
import type { UpstreamBodies } from "./upstream.ts";
import { renderRegion } from "./write_split.ts";

type SourcedEntry = ManagedEntry | StarterEntry | SplitEntry;

/** A fetched block carries no heading of its own, so the region's comment syntax names it and its origin; a tree block
 *  writes its own, and an entry without a region takes the body bare. */
export function blockHeading(region: RegionKind | null, title: string): string {
  if (region === null) return "";
  return region === "hash" ? `## ${title}\n` : `<!-- ${title} -->\n`;
}

/** Ends with a blank line: the next block's heading must not butt against this body. */
export function upstreamBlock(
  region: RegionKind | null,
  value: string,
  ref: UpstreamRef,
  body: string,
): string {
  return `${blockHeading(region, `${value} (${ref.repository} ${ref.path})`)}${body}\n\n`;
}

/** The callback keeps `to` literal: a string replacement would read `$&` and `$$` as patterns. */
export function rewritten(text: string, replace: Record<string, string> = {}): string {
  return Object.entries(replace).reduce((out, [from, to]) => out.replaceAll(from, () => to), text);
}

export function renderSourced(
  config: FilesConfig,
  tree: string,
  entry: SourcedEntry,
  modules: string[],
  values: PlaceholderValues,
  upstream: UpstreamBodies,
): string | { missing: string[] } {
  const raw = (rel: string) => readFileSync(join(tree, rel), "utf-8");
  const fetched = (ref: UpstreamRef) => rewritten(upstream.body(ref), entry.replace);
  const region = entry.class === "split" ? entry.region : null;
  const blocks = blockSources(config, entry, modules).map(({ value, source }) =>
    typeof source === "string"
      ? raw(source)
      : upstreamBlock(region, value, source, fetched(source)),
  );
  const source =
    typeof entry.source === "string" ? raw(entry.source) : `${fetched(entry.source)}\n`;
  const spliced = spliceBlocks(source, blocks);
  const missing = missingPlaceholders(spliced, values);
  if (missing.length > 0) return { missing };
  const body = substitute(spliced, values);
  return region === null ? body : renderRegion(body, regionMarkers(region));
}
