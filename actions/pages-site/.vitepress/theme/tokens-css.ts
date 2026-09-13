// The token layer is rendered from tokens.ts at build time: config.mts installs the plugin, and index.ts imports the
// virtual module first so every component rule reads the fleet's values. Nothing on disk holds the CSS.
// The print block is rendered last on purpose: its selectors (html:root, html:root.dark) only tie the light and dark
// hue blocks on specificity, so cascade order decides.

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
} from "./tokens.ts";

/** The `.css` suffix routes the module through Vite's CSS pipeline like a file. */
export const TOKENS_CSS_ID = "virtual:fleet-tokens.css";
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
  const shared = Object.values(SHARED_TOKENS).flatMap(
    (group) => Object.entries(group) as [TokenName, SharedValue][],
  );
  const base = (value: SharedValue): string => (typeof value === "string" ? value : value.base);
  const overrides = (value: SharedValue): readonly MediaOverride[] =>
    typeof value === "string" ? [] : value.overrides;
  const lines: string[] = block(
    BOTH_MODES,
    shared.map(([name, value]) => [name, base(value)]),
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
  lines.push(
    "",
    "@media print {",
    ...modeBlock("html:root,\nhtml:root.dark", "print", "  "),
    "}",
    "",
  );
  return lines.join("\n");
}

export interface TokensCssPlugin {
  name: string;
  resolveId(id: string): string | undefined;
  load(id: string): string | undefined;
}

export function tokensCssPlugin(): TokensCssPlugin {
  const resolved = `\0${TOKENS_CSS_ID}`;
  return {
    name: "fleet-tokens-css",
    resolveId: (id) => (id === TOKENS_CSS_ID ? resolved : undefined),
    load: (id) => (id === resolved ? themeTokensCss() : undefined),
  };
}
