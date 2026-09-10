// Split files: the writer owns the marker-bounded region and the repository
// owns everything above and below it. A file without markers keeps its
// whole content below the new region; a file whose markers are duplicated
// or out of order is refused loudly, since no slice of it is honest.

import {
  cleanManagedRegion,
  markerLineCount,
  type RegionMarkers,
} from "../../../../actions/shared/grammar.ts";
import { sha256 } from "./manifest.ts";
import { existingFile, type WriteOutcome, writeFile } from "./write_managed.ts";

/** The region text: the BEGIN line, the body (newline-terminated), the END line. */
export function renderRegion(body: string, markers: RegionMarkers): string {
  const terminated = body === "" || body.endsWith("\n") ? body : `${body}\n`;
  return `${markers.begin}\n${terminated}${markers.end}\n`;
}

export function writeSplit(
  target: string,
  path: string,
  region: string,
  markers: RegionMarkers,
  recorded: string | null,
): WriteOutcome {
  const regionBytes = Buffer.from(region, "utf-8");
  const existing = existingFile(target, path);
  if (existing === null) {
    writeFile(target, path, regionBytes);
    return { change: "created" };
  }
  // latin1 round-trips every byte, so slicing and reassembly never alter
  // the repository-owned parts.
  const text = existing.toString("latin1");
  const hasMarkers = [markers.begin, markers.end].some((m) => markerLineCount(text, m) > 0);
  if (!hasMarkers) {
    writeFile(target, path, Buffer.concat([regionBytes, existing]));
    return { change: "updated" };
  }
  const slice = cleanManagedRegion(text, markers);
  if (slice === null) {
    throw new Error(
      `${path}: the managed-region markers are duplicated or out of order; fix the file by hand`,
    );
  }
  const previous = Buffer.from(slice.region, "latin1");
  if (previous.equals(regionBytes)) return { change: "unchanged" };
  writeFile(
    target,
    path,
    Buffer.concat([
      Buffer.from(slice.above, "latin1"),
      regionBytes,
      Buffer.from(slice.below, "latin1"),
    ]),
  );
  if (recorded !== null && sha256(previous) === recorded) return { change: "updated" };
  return { change: "replaced local edits", replaced: previous.toString("utf-8") };
}
