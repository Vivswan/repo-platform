// The GENERATED-region marker grammar and the splicers that rewrite a
// region's body between its hand-placed BEGIN/END markers: line-comment
// markers on lines of their own, markdown markers inline.

/** The marker grammar's kind tokens. The ssot checker's stripGeneratedRegions
 *  (scripts/check/ssot/comparison.ts) builds its matcher from these, so
 *  renaming the marker text here cannot leave that stripper silently
 *  matching nothing. */
export const MARKER_TOKENS = { begin: "BEGIN GENERATED:", end: "END GENERATED:" } as const;

/** What the BEGIN marker tells editors to edit instead of the region; most
 *  regions derive from the module manifests alone, and a region with more
 *  sources names them all. */
const DEFAULT_REGION_SOURCES = "module.yml manifests";

function markerTexts(name: string, sources: string): { begin: string; end: string } {
  return {
    begin: `${MARKER_TOKENS.begin} ${name} (scripts/generate.ts - edit ${sources}, not this block)`,
    end: `${MARKER_TOKENS.end} ${name}`,
  };
}

/** The BEGIN/END marker comment lines fencing a line-syntax region. A
 *  suffix closes comment syntaxes that need one (jinja's `#}`). */
export function markerLines(
  name: string,
  prefix: string,
  suffix = "",
  sources = DEFAULT_REGION_SOURCES,
): { begin: string; end: string } {
  const texts = markerTexts(name, sources);
  const close = suffix === "" ? "" : ` ${suffix}`;
  return { begin: `${prefix} ${texts.begin}${close}`, end: `${prefix} ${texts.end}${close}` };
}

/** The `<!-- ... -->` marker pair fencing an inline markdown region. */
export function mdMarkers(name: string): { begin: string; end: string } {
  const texts = markerTexts(name, DEFAULT_REGION_SOURCES);
  return { begin: `<!-- ${texts.begin} -->`, end: `<!-- ${texts.end} -->` };
}

/** A body that carries its own marker text would splice cleanly once and
 *  corrupt the next run's marker matching; refuse it up front. */
function rejectSmuggledMarkers(body: string, file: string, name: string, markers: string[]): void {
  if (markers.some((marker) => body.includes(marker))) {
    throw new Error(
      `${file}: region '${name}' body contains its own marker text - ` +
        "that would break the next regeneration's marker matching",
    );
  }
}

/** Replace the lines strictly between a region's markers with `body`.
 *  Markers are matched by trimmed content (they may be indented) and kept
 *  verbatim; a missing, duplicated, or misordered marker throws. */
export function spliceRegion(
  text: string,
  file: string,
  name: string,
  prefix: string,
  body: string[],
  suffix = "",
  sources = DEFAULT_REGION_SOURCES,
): string {
  const { begin, end } = markerLines(name, prefix, suffix, sources);
  rejectSmuggledMarkers(body.join("\n"), file, name, [begin, end]);
  const lines = text.split("\n");
  const at = (marker: string) =>
    lines.flatMap((line, index) => (line.trim() === marker ? [index] : []));
  const begins = at(begin);
  const ends = at(end);
  if (begins.length !== 1 || ends.length !== 1) {
    throw new Error(
      `${file}: region '${name}' needs exactly one BEGIN and one END marker, ` +
        `found ${begins.length} and ${ends.length} - restore the marker pair`,
    );
  }
  if (ends[0] < begins[0]) {
    throw new Error(`${file}: region '${name}' has its END marker before BEGIN - swap them`);
  }
  return [...lines.slice(0, begins[0] + 1), ...body, ...lines.slice(ends[0])].join("\n");
}

/** Replace the substring strictly between a markdown region's inline
 *  markers with `body`.
 *
 *  A `string[]` body is a multi-line span: the BEGIN marker ends the line
 *  preceding the region, so the body's lines start on a fresh line. A
 *  `string` body is a single-line inline span (a table cell, or prose
 *  continuing the marker's own sentence) and must stay one line - a
 *  newline would end the row or hard-wrap the paragraph. */
export function spliceInlineRegion(
  text: string,
  file: string,
  name: string,
  body: string | string[],
): string {
  const { begin, end } = mdMarkers(name);
  if (typeof body === "string" && /[\r\n]/.test(body)) {
    throw new Error(
      `${file}: inline region '${name}' is a single-line span; its body must be a single line`,
    );
  }
  const spliced = typeof body === "string" ? body : `\n${body.join("\n")}`;
  rejectSmuggledMarkers(spliced, file, name, [begin, end]);
  const at = (marker: string, which: string) => {
    const first = text.indexOf(marker);
    if (first === -1 || text.indexOf(marker, first + 1) !== -1) {
      throw new Error(
        `${file}: inline region '${name}' needs exactly one ${which} ` +
          "marker - restore the marker pair",
      );
    }
    return first;
  };
  const begins = at(begin, "BEGIN");
  const ends = at(end, "END");
  if (ends < begins) {
    throw new Error(`${file}: inline region '${name}' has its END marker before BEGIN - swap them`);
  }
  return text.slice(0, begins + begin.length) + spliced + text.slice(ends);
}
