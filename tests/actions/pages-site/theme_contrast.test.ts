// The theme's text tokens are small type on every ground the theme declares
// (the 12.5px provenance line and the code block's language label both read
// --vp-c-text-3), so each text token must clear WCAG AA's 4.5:1 on each
// ground of its mode; the code palette (--fleet-code-*, the shiki theme's
// variables) must clear it on the code ground, and the two alert colors
// that are not the hue on the custom block's panel ground. The token test
// next door only proves a reader exists; this pins the values themselves,
// per mode (light, dark, and the print sheet), as tokens.ts declares them.

import { expect, test } from "bun:test";
import {
  HUES,
  MODES,
  modeValues,
  type ScreenMode,
} from "../../../actions/pages-site/.vitepress/theme/tokens.ts";

const AA_SMALL_TEXT = 4.5;
const TEXT_TOKENS = ["--vp-c-text-1", "--vp-c-text-2", "--vp-c-text-3"];
const GROUND_TOKEN = /^--(vp-c-bg(-[a-z0-9-]+)?|fleet-field-bg)$/;
const CODE_TOKEN = /^--fleet-code-/;
const CODE_GROUND = "--vp-c-bg-code";
const ALERT_TOKENS = ["--color-warning", "--color-caution"];
const ALERT_GROUND = "--vp-c-bg-soft";
const HEX = /^#[0-9a-f]{6}$/i;
const SCREEN_MODES: ScreenMode[] = ["light", "dark"];

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
 *  either side is not a six-digit hex (a var() alias, a short hex, a color
 *  name) fails outright instead of being skipped. */
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

test.each([...MODES])("every %s text token clears 4.5:1 on every ground of its mode", (mode) => {
  const declared = modeValues(mode);
  expect(failures(declared, textPairs(declared))).toEqual([]);
});

test.each([...MODES])(
  "every %s code token clears 4.5:1 on the code ground, every alert color on the panel",
  (mode) => {
    const declared = modeValues(mode);
    expect(failures(declared, palettePairs(declared))).toEqual([]);
  },
);

// The instrument's controls, through the same reader and assertion path as
// the green runs above: the comment token set to a var() alias or to a
// failing hex must fail, and as the only failure.
test.each([
  ["var(--vp-c-bg-code)", "is not declared as a six-digit hex"],
  ["#8c94a6", "on --vp-c-bg-code #eaecf0: 2.57:1"],
])("the light comment token set to %s fails the palette check", (value, message) => {
  const declared = new Map(modeValues("light"));
  declared.set("--fleet-code-token-comment", value);
  const failing = failures(declared, palettePairs(declared));
  expect(failing).toHaveLength(1);
  expect(failing[0]).toStartWith("--fleet-code-token-comment");
  expect(failing[0]).toEndWith(message);
});

// The hue band is a hover tint on the page ground (the pager links, the
// launcher's rows), so the text it sits under must clear AA on the
// composite in every hue and mode: the secondary ink does, the tertiary
// ink does not (its control), which is why a hovered pager label lifts
// to the secondary ink.
const RGBA = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*(0?\.\d+)\)$/;

function channels(hex: string): number[] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

/** The band composited over `ground`, as a six-digit hex. */
function tinted(band: string, ground: string): string {
  const match = RGBA.exec(band);
  if (match === null) throw new Error(`the hue band is not an rgba(): ${band}`);
  const alpha = Number(match[4]);
  return `#${channels(ground)
    .map((channel, i) => Math.round(Number(match[i + 1]) * alpha + channel * (1 - alpha)))
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

test.each(SCREEN_MODES)(
  "the secondary ink clears 4.5:1 on every hue's band over the %s ground; the tertiary does not",
  (mode) => {
    const base = modeValues(mode);
    const ground = base.get("--vp-c-bg");
    const secondary = base.get("--vp-c-text-2");
    const tertiary = base.get("--vp-c-text-3");
    if (ground === undefined || secondary === undefined || tertiary === undefined) {
      throw new Error(`${mode} lacks a ground or an ink`);
    }
    expect(HUES).toHaveLength(6);
    const bands = HUES.map((hue) => tinted(hue[mode].band, ground));
    expect(bands.filter((tint) => contrast(secondary, tint) < AA_SMALL_TEXT)).toEqual([]);
    expect(bands.filter((tint) => contrast(tertiary, tint) < AA_SMALL_TEXT)).toEqual(bands);
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
