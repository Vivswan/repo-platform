// The mermaid theme as a function of the fleet's tokens. Mermaid bakes
// literal colors into each SVG (it derives the rest of its palette from
// them), so var() references cannot be handed over: the values are read
// from tokens.ts per mode and hue, and theme_contrast.test.ts holds every
// text variable to 4.5:1 on the surface it is drawn over. Browser-safe: the
// client bundle imports it.

import { type Hue, MODE_TOKENS, type ScreenMode, SHARED_TOKENS } from "./tokens.ts";

/** Mermaid's `themeVariables` for its `base` theme: the diagram ground is
 *  the code ground (the mount's own), nodes and actors sit on the panel
 *  ground with the hue as their border, notes and labels on the raised
 *  ground, lines in the secondary ink, every text in the primary ink. */
export function mermaidThemeVariables(mode: ScreenMode, hue: Hue) {
  const ground = MODE_TOKENS.grounds["--vp-c-bg-code"][mode];
  const panel = MODE_TOKENS.grounds["--vp-c-bg-soft"][mode];
  const raised = MODE_TOKENS.grounds["--vp-c-bg-soft-2"][mode];
  const ink = MODE_TOKENS.text["--vp-c-text-1"][mode];
  const line = MODE_TOKENS.text["--vp-c-text-2"][mode];
  const accent = hue[mode].hue;
  return {
    darkMode: mode === "dark",
    fontFamily: SHARED_TOKENS.fonts["--vp-font-family-mono"],
    fontSize: SHARED_TOKENS.code["--vp-code-font-size"],
    background: ground,
    primaryColor: panel,
    primaryTextColor: ink,
    primaryBorderColor: accent,
    secondaryColor: raised,
    secondaryTextColor: ink,
    secondaryBorderColor: accent,
    tertiaryColor: ground,
    tertiaryTextColor: ink,
    tertiaryBorderColor: line,
    textColor: ink,
    titleColor: ink,
    lineColor: line,
    arrowheadColor: line,
    mainBkg: panel,
    nodeBorder: accent,
    clusterBkg: raised,
    clusterBorder: line,
    edgeLabelBackground: ground,
    noteBkgColor: raised,
    noteTextColor: ink,
    noteBorderColor: accent,
    actorBkg: panel,
    actorBorder: accent,
    actorTextColor: ink,
    actorLineColor: line,
    signalColor: line,
    signalTextColor: ink,
    labelBoxBkgColor: raised,
    labelBoxBorderColor: accent,
    labelTextColor: ink,
    loopTextColor: ink,
    activationBkgColor: raised,
    activationBorderColor: accent,
    sequenceNumberColor: ground,
  };
}

export type MermaidThemeVariables = ReturnType<typeof mermaidThemeVariables>;
