import { describe, expect, test } from "bun:test";
import { maskForms } from "../../.github/scripts/shared/mask.ts";

const HIDDEN = "Vivswan/Hidden-Server";
/** Every spelling a job log can carry of the name, one per line. */
const SPELLINGS = [
  "Vivswan/Hidden-Server",
  "vivswan/hidden-server",
  "https://github.com/Vivswan/Hidden-Server",
  "https://github.com/vivswan/hidden-server",
  "https://github.com/Vivswan/Hidden-Server.git",
  "https://github.com/vivswan/hidden-server.git",
  "git@github.com:Vivswan/Hidden-Server.git",
  "git@github.com:vivswan/hidden-server.git",
  "Hidden-Server",
  "hidden-server",
].join("\n");
/** The runner's masker: every case-sensitive substring occurrence of a registered value, overlapping
 *  matches merged into one `***`, so a value inside a longer registered value shows nothing of either. */
function runnerMask(log: string, values: string[]): string {
  const ranges: [number, number][] = [];
  for (const value of values) {
    for (let at = log.indexOf(value); at !== -1; at = log.indexOf(value, at + 1)) {
      ranges.push([at, at + value.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) {
      cursor = Math.max(cursor, end);
      continue;
    }
    out += `${log.slice(cursor, start)}***`;
    cursor = end;
  }
  return out + log.slice(cursor);
}

describe("maskForms", () => {
  test.each<{ slug: string; forms: string[] }>([
    {
      slug: HIDDEN,
      forms: ["Vivswan/Hidden-Server", "vivswan/hidden-server", "Hidden-Server", "hidden-server"],
    },
    { slug: "vivswan/hidden-server", forms: ["vivswan/hidden-server", "hidden-server"] },
    // A short bare name is not masked on its own: it would garble every innocent occurrence.
    { slug: "Vivswan/api", forms: ["Vivswan/api", "vivswan/api"] },
  ])("$slug registers $forms, once each", ({ slug, forms }) => {
    expect(maskForms(slug)).toEqual(forms);
  });

  test("the forms leave no spelling of the name in a log, the URL ones falling with the slug", () => {
    expect(runnerMask(SPELLINGS, maskForms(HIDDEN))).toBe(
      [
        "***",
        "***",
        "https://github.com/***",
        "https://github.com/***",
        "https://github.com/***.git",
        "https://github.com/***.git",
        "git@github.com:***.git",
        "git@github.com:***.git",
        "***",
        "***",
      ].join("\n"),
    );
  });

  // The library CLI the settings row hands the slug to registers it as --repos spelled it (its
  // planRedaction), nothing else: the control that the forms above are not redundant with it.
  test("the CLI's slug mask alone leaves the lower-case spellings and the bare name", () => {
    expect(runnerMask(SPELLINGS, [HIDDEN])).toBe(
      [
        "***",
        "vivswan/hidden-server",
        "https://github.com/***",
        "https://github.com/vivswan/hidden-server",
        "https://github.com/***.git",
        "https://github.com/vivswan/hidden-server.git",
        "git@github.com:***.git",
        "git@github.com:vivswan/hidden-server.git",
        "Hidden-Server",
        "hidden-server",
      ].join("\n"),
    );
  });
});
