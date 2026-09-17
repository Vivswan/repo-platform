// The tertiary ink is small type (the 12.5px provenance line, the code block's language label), so every text token must clear WCAG AA's 4.5:1.
// theme_tokens.test.ts proves each token has a reader and that the render is the data; this pins the values themselves,
// per mode and ground, the print sheet included.

import { expect, test } from "bun:test";
import Color from "colorjs.io";
import { mermaidThemeVariables } from "../../../actions/pages-site/.vitepress/theme/mermaid-theme.ts";
import {
  HUES,
  MODES,
  modeValues,
  type ScreenMode,
  SHARED_TOKENS,
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

function failures(declared: Map<string, string>, pairs: [string, string][]): string[] {
  return pairs.flatMap(([text, ground]) => {
    const fg = declared.get(text);
    const bg = declared.get(ground);
    if (fg === undefined || bg === undefined || !HEX.test(fg) || !HEX.test(bg)) {
      return [`${text} (${fg}) or ${ground} (${bg}) is not declared as a six-digit hex`];
    }
    const ratio = Color.contrast(bg, fg, "WCAG21");
    return ratio < AA_SMALL_TEXT ? [`${text} ${fg} on ${ground} ${bg}: ${ratio.toFixed(2)}:1`] : [];
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

test.each([...MODES])(
  "every %s text token clears 4.5:1 on every ground of its mode, every code token on the code ground, every alert color on the panel",
  (mode) => {
    const declared = modeValues(mode);
    expect(failures(declared, [...textPairs(declared), ...palettePairs(declared)])).toEqual([]);
  },
);

// The armed control of the measurement: a non-hex value is reported, never skipped.
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

// The hue band is a hover tint on the page ground (pager links, the launcher's rows), so the ink under it must clear AA on the composite.
// The tertiary ink does not, which is why a hovered pager label lifts to the secondary ink.
function tinted(band: string, ground: string): Color {
  const tint = new Color(band);
  const alpha = tint.alpha;
  tint.alpha = 1;
  return Color.mix(ground, tint, alpha, { space: "srgb" });
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
    const aa = (ink: string) =>
      bands.filter((tint) => Color.contrast(tint, ink, "WCAG21") < AA_SMALL_TEXT);
    expect(aa(secondary)).toEqual([]);
    expect(aa(tertiary)).toEqual(bands);
  },
);

// The mermaid theme bakes literal colors into every diagram's SVG, so its text meets the same bar on the ground it is drawn over.
// The hue is a border color only, so it may not move any of these pairs.
const MERMAID_TEXT_PAIRS: [string, string][] = [
  ["primaryTextColor", "primaryColor"],
  ["secondaryTextColor", "secondaryColor"],
  ["tertiaryTextColor", "tertiaryColor"],
  ["textColor", "background"],
  ["textColor", "edgeLabelBackground"],
  ["titleColor", "background"],
  ["lineColor", "background"],
  ["noteTextColor", "noteBkgColor"],
  ["actorTextColor", "actorBkg"],
  ["signalTextColor", "background"],
  ["labelTextColor", "labelBoxBkgColor"],
  ["loopTextColor", "background"],
  ["sequenceNumberColor", "lineColor"],
];

test.each(SCREEN_MODES)(
  "every %s mermaid text variable clears 4.5:1 on its ground in every hue, in that mode's type",
  (mode) => {
    for (const hue of HUES) {
      const variables = mermaidThemeVariables(mode, hue);
      const declared = new Map(
        Object.entries(variables).filter((entry): entry is [string, string] => {
          return typeof entry[1] === "string";
        }),
      );
      expect(failures(declared, MERMAID_TEXT_PAIRS)).toEqual([]);
      expect(variables.darkMode).toBe(mode === "dark");
      expect(variables.fontFamily).toBe(SHARED_TOKENS.fonts["--vp-font-family-mono"]);
      expect(variables.nodeBorder).toBe(hue[mode].hue);
    }
  },
);
