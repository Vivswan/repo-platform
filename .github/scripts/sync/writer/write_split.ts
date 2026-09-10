// Split files: the writer owns the marker-bounded region and the repository
// owns everything above and below it. A file without markers keeps its
// whole content below the new region; a file whose markers are duplicated
// or out of order is refused loudly, since no slice of it is honest.

import {
  cleanManagedRegion,
  type RegionMarkers,
  substringCount,
} from "../../../../actions/shared/grammar.ts";
import { mentionsMarkers } from "./files_config.ts";
import { sha256 } from "./manifest.ts";
import { existingFile, writeFile } from "./target_files.ts";
import type { WriteOutcome } from "./write_managed.ts";

/** `text` ending in exactly the newline it needs to be followed by more. */
export function terminated(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

/** The region text: the BEGIN line, the body (newline-terminated), the END
 *  line. A body that already mentions a marker (a placeholder value can
 *  carry one) is refused: the file would have no honest slice next run. */
export function renderRegion(body: string, markers: RegionMarkers): string {
  if (mentionsMarkers(body, markers)) {
    throw new Error("the region body mentions the marker text the writer adds itself");
  }
  return `${markers.begin}\n${terminated(body)}${markers.end}\n`;
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
  const mentions = [markers.begin, markers.end].some((m) => substringCount(text, m) > 0);
  if (!mentions) {
    writeFile(target, path, Buffer.concat([regionBytes, existing]));
    return { change: "updated" };
  }
  // Marker text anywhere but as one clean line each (a duplicate, a
  // mid-line mention) leaves no honest slice, now or on the next run.
  const slice = cleanManagedRegion(text, markers);
  if (slice === null) {
    throw new Error(
      `${path}: the managed-region marker text is duplicated, out of order, or buried mid-line; fix the file by hand`,
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
