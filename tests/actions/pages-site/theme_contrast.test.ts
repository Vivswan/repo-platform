// The theme's text tokens are small type on every ground the theme declares
// (the 12.5px provenance line and the code block's language label both read
// --vp-c-text-3), so each text token must clear WCAG AA's 4.5:1 on each
// ground of its mode. The token test next door only proves a reader exists;
// this pins the values themselves, per mode, against the CSS as written.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CUSTOM_CSS = resolve(
  import.meta.dir,
  "../../../actions/pages-site/.vitepress/theme/custom.css",
);
const AA_SMALL_TEXT = 4.5;
const TEXT_TOKENS = ["--vp-c-text-1", "--vp-c-text-2", "--vp-c-text-3"];
const GROUND_TOKEN = /^--(vp-c-bg(-[a-z0-9-]+)?|fleet-field-bg)$/;
const HEX_DECLARATION = /^\s*(--[a-z0-9-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gim;

/** Every hex-valued declaration under blocks whose whole selector is
 *  `selector`, later declarations winning, as the cascade resolves them. */
function modeTokens(css: string, selector: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const block of css.split("}")) {
    const brace = block.lastIndexOf("{");
    if (block.slice(0, brace).trim().split("\n").at(-1)?.trim() !== selector) continue;
    for (const match of block.slice(brace + 1).matchAll(HEX_DECLARATION)) {
      tokens.set(match[1], match[2].toLowerCase());
    }
  }
  return tokens;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

test.each([
  [":root", "light"],
  [".dark", "dark"],
])("every %s (%s) text token clears 4.5:1 on every ground of its mode", (selector) => {
  const tokens = modeTokens(readFileSync(CUSTOM_CSS, "utf-8"), selector);
  const grounds = [...tokens].filter(([name]) => GROUND_TOKEN.test(name));
  expect(grounds.length).toBeGreaterThanOrEqual(5);
  const failing = TEXT_TOKENS.flatMap((text) => {
    const fg = tokens.get(text);
    if (fg === undefined) return [`${text} is not declared`];
    return grounds
      .filter(([, bg]) => contrast(fg, bg) < AA_SMALL_TEXT)
      .map(([ground, bg]) => `${text} ${fg} on ${ground} ${bg}: ${contrast(fg, bg).toFixed(2)}:1`);
  });
  expect(failing).toEqual([]);
});

// The instrument's control: the tertiary values the theme shipped before the
// contrast fix fail on the code ground, so a green run above means the
// values pass, not that the check cannot go red.
test("the pre-fix tertiary values fail the same check on the code ground", () => {
  expect(contrast("#737b89", "#eaecf0")).toBeLessThan(AA_SMALL_TEXT);
  expect(contrast("#80889a", "#262a32")).toBeLessThan(AA_SMALL_TEXT);
  expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
});
