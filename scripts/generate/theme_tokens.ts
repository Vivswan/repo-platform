// Renders the theme's token data (actions/pages-site/.vitepress/theme/
// tokens.ts) into tokens.css: the shared tokens on :root and .dark with
// their media overrides, the light palette on :root, the dark one on .dark,
// one block per hue slot and mode, and the print overrides on html:root
// (which outranks :root, .dark and the hue blocks at equal or higher
// specificity, so it must come last).

import {
  HUE_TOKENS,
  HUES,
  type HueValues,
  type MediaOverride,
  type Mode,
  modeValues,
  SHARED_TOKENS,
  type SharedValue,
  type TokenName,
} from "../../actions/pages-site/.vitepress/theme/tokens.ts";
import { markerLines } from "./markers.ts";

export const THEME_TOKENS_CSS = "actions/pages-site/.vitepress/theme/tokens.css";
const THEME_TOKENS_SOURCE = "actions/pages-site/.vitepress/theme/tokens.ts";
const BOTH_MODES = ":root,\n.dark";

function block(
  selector: string,
  declarations: Iterable<[TokenName, string]>,
  indent = "",
): string[] {
  return [
    `${indent}${selector.replaceAll("\n", `\n${indent}`)} {`,
    ...[...declarations].map(([name, value]) => `${indent}  ${name}: ${value};`),
    `${indent}}`,
  ];
}

function hueDeclarations(values: HueValues): [TokenName, string][] {
  return (Object.entries(HUE_TOKENS) as [keyof HueValues, TokenName][]).map(([key, name]) => [
    name,
    values[key],
  ]);
}

function modeBlock(selector: string, mode: Mode, indent = ""): string[] {
  return block(selector, modeValues(mode), indent);
}

export function themeTokensCss(): string {
  const marker = markerLines("theme-tokens", "/*", "*/", THEME_TOKENS_SOURCE);
  const shared = Object.values(SHARED_TOKENS).flatMap(
    (group) => Object.entries(group) as [TokenName, SharedValue][],
  );
  const base = (value: SharedValue): string => (typeof value === "string" ? value : value.base);
  const overrides = (value: SharedValue): readonly MediaOverride[] =>
    typeof value === "string" ? [] : value.overrides;
  const lines: string[] = [marker.begin, ""];
  lines.push(
    ...block(
      BOTH_MODES,
      shared.map(([name, value]) => [name, base(value)]),
    ),
  );
  for (const [name, value] of shared) {
    for (const { media, value: narrowed } of overrides(value)) {
      lines.push("", `@media ${media} {`, ...block(BOTH_MODES, [[name, narrowed]], "  "), "}");
    }
  }
  lines.push("", ...modeBlock(":root", "light"));
  lines.push("", ...modeBlock(".dark", "dark"));
  HUES.forEach((hue, slot) => {
    if (slot === 0) return;
    lines.push("", ...block(`html[data-fleet-hue="${slot}"]`, hueDeclarations(hue.light)));
    lines.push("", ...block(`html.dark[data-fleet-hue="${slot}"]`, hueDeclarations(hue.dark)));
  });
  lines.push("", "@media print {", ...modeBlock("html:root,\nhtml:root.dark", "print", "  "), "}");
  lines.push("", marker.end, "");
  return lines.join("\n");
}
