// The theme's text tokens are small type on every ground the theme declares
// (the 12.5px provenance line and the code block's language label both read
// --vp-c-text-3), so each text token must clear WCAG AA's 4.5:1 on each
// ground of its mode; the code palette (--fleet-code-*, the shiki theme's
// variables) must clear it on the code ground, and the two alert colors
// that are not the hue on the custom block's panel ground. The token test
// next door only proves a reader exists; this pins the values themselves,
// per mode, against the CSS as written.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const THEME = resolve(import.meta.dir, "../../../actions/pages-site/.vitepress/theme");
const CUSTOM_CSS = join(THEME, "custom.css");
/** The three palettes: light and dark from the token layer, and the print
 *  sheet's, declared in components.css over the dark mode's html. */
const PALETTES: [string, string, string][] = [
  [":root", "light", CUSTOM_CSS],
  [".dark", "dark", CUSTOM_CSS],
  ["html:root.dark", "print", join(THEME, "components.css")],
];
const AA_SMALL_TEXT = 4.5;
const TEXT_TOKENS = ["--vp-c-text-1", "--vp-c-text-2", "--vp-c-text-3"];
const GROUND_TOKEN = /^--(vp-c-bg(-[a-z0-9-]+)?|fleet-field-bg)$/;
const CODE_TOKEN = /^--fleet-code-/;
const CODE_GROUND = "--vp-c-bg-code";
const ALERT_TOKENS = ["--color-warning", "--color-caution"];
const ALERT_GROUND = "--vp-c-bg-soft";
const DECLARATION = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]*?)\s*;/gm;
const HEX = /^#[0-9a-f]{6}$/i;

/** Every declaration under blocks whose whole selector is `selector`, as
 *  written, later declarations winning the way the cascade resolves them.
 *  Values are kept raw so a token redeclared as a var(), a short hex, or a
 *  color name fails the measurement instead of leaving an earlier hex in
 *  place. */
function modeDeclarations(css: string, selector: string): Map<string, string> {
  const declared = new Map<string, string>();
  for (const block of css.split("}")) {
    const brace = block.lastIndexOf("{");
    if (block.slice(0, brace).trim().split("\n").at(-1)?.trim() !== selector) continue;
    for (const match of block.slice(brace + 1).matchAll(DECLARATION)) {
      declared.set(match[1], match[2].toLowerCase());
    }
  }
  return declared;
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

/** The text-on-ground pairs that fail AA, one line each; a pair whose
 *  either side is not a six-digit hex fails outright. */
function failures(declared: Map<string, string>, pairs: [string, string][]): string[] {
  return pairs.flatMap(([text, ground]) => {
    const fg = declared.get(text);
    const bg = declared.get(ground);
    if (fg === undefined || bg === undefined || !HEX.test(fg) || !HEX.test(bg)) {
      return [`${text} (${fg}) or ${ground} (${bg}) is not declared as a six-digit hex`];
    }
    return contrast(fg, bg) < AA_SMALL_TEXT
      ? [`${text} ${fg} on ${ground} ${bg}: ${contrast(fg, bg).toFixed(2)}:1`]
      : [];
  });
}

function textPairs(declared: Map<string, string>): [string, string][] {
  const grounds = [...declared.keys()].filter((name) => GROUND_TOKEN.test(name));
  expect(grounds.length).toBeGreaterThanOrEqual(5);
  return TEXT_TOKENS.flatMap((text) => grounds.map((ground): [string, string] => [text, ground]));
}

function palettePairs(declared: Map<string, string>): [string, string][] {
  const codeTokens = [...declared.keys()].filter((name) => CODE_TOKEN.test(name));
  expect(codeTokens.length).toBeGreaterThanOrEqual(12);
  return [
    ...codeTokens.map((name): [string, string] => [name, CODE_GROUND]),
    ...ALERT_TOKENS.map((name): [string, string] => [name, ALERT_GROUND]),
  ];
}

test.each([
  [":root", "light"],
  [".dark", "dark"],
])("every %s (%s) text token clears 4.5:1 on every ground of its mode", (selector) => {
  const declared = modeDeclarations(readFileSync(CUSTOM_CSS, "utf-8"), selector);
  expect(failures(declared, textPairs(declared))).toEqual([]);
});

test.each(PALETTES)(
  "every %s (%s) code token clears 4.5:1 on the code ground, every alert color on the panel",
  (selector, _mode, file) => {
    const declared = modeDeclarations(readFileSync(file, "utf-8"), selector);
    expect(failures(declared, palettePairs(declared))).toEqual([]);
  },
);

// The instrument's controls, through the same reader and assertion path as
// the green runs above: a later block redeclaring a passing token as a
// var() or as a failing hex must fail, so a green run means the values as
// the cascade resolves them pass, not that an earlier hex was measured.
test.each([
  ["var(--vp-c-bg-code)", "is not declared as a six-digit hex"],
  ["#8c94a6", "on --vp-c-bg-code #eaecf0: 2.57:1"],
])(
  "a later :root redeclaration of the comment token as %s fails the palette check",
  (value, message) => {
    const css = `${readFileSync(CUSTOM_CSS, "utf-8")}\n:root {\n  --fleet-code-token-comment: ${value};\n}\n`;
    const declared = modeDeclarations(css, ":root");
    const failing = failures(declared, palettePairs(declared));
    expect(failing).toHaveLength(1);
    expect(failing[0]).toStartWith("--fleet-code-token-comment");
    expect(failing[0]).toEndWith(message);
  },
);

// The values the theme replaced fail the same measurement: the tertiary text
// values shipped before the contrast fix on the code grounds, and shiki's
// github themes' comment gray and light string green on the fleet's.
test("the pre-fix tertiary values and the github-theme token colors fail on the code grounds", () => {
  expect(contrast("#737b89", "#eaecf0")).toBeLessThan(AA_SMALL_TEXT);
  expect(contrast("#80889a", "#262a32")).toBeLessThan(AA_SMALL_TEXT);
  expect(contrast("#6a737d", "#23262e")).toBeLessThan(AA_SMALL_TEXT);
  expect(contrast("#6a737d", "#eaecf0")).toBeLessThan(AA_SMALL_TEXT);
  expect(contrast("#22863a", "#eaecf0")).toBeLessThan(AA_SMALL_TEXT);
  expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
});
