#!/usr/bin/env bun
// The print block is rendered last on purpose: its selectors (html:root, html:root.dark) only tie
// the light and dark hue blocks on specificity, so cascade order decides.
//
// Usage: bun scripts/generate/theme_tokens.ts [--check]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
export const THEME_TOKENS_CSS = "actions/pages-site/.vitepress/theme/tokens.css";
const THEME_TOKENS_SOURCE = "actions/pages-site/.vitepress/theme/tokens.ts";
const BOTH_MODES = ":root,\n.dark";

const MARKER = {
  begin: `/* BEGIN GENERATED: theme-tokens (scripts/generate/theme_tokens.ts - edit ${THEME_TOKENS_SOURCE}, not this block) */`,
  end: "/* END GENERATED: theme-tokens */",
};

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
  const lines: string[] = [MARKER.begin, ""];
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
  lines.push("", MARKER.end, "");
  return lines.join("\n");
}

export function themeCssCurrent(path: string): boolean {
  return existsSync(path) && readFileSync(path, "utf-8") === themeTokensCss();
}

function main(argv: string[]): number {
  const check = argv.includes("--check");
  const unknown = argv.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    console.error(`error: unrecognized argument(s): ${unknown.join(" ")}`);
    return 2;
  }
  const path = join(REPO_ROOT, THEME_TOKENS_CSS);
  if (themeCssCurrent(path)) {
    console.log(`${THEME_TOKENS_CSS} matches ${THEME_TOKENS_SOURCE}`);
    return 0;
  }
  if (check) {
    console.log(
      `${THEME_TOKENS_CSS} is stale: its content does not match the token data in ${THEME_TOKENS_SOURCE}; run bun run theme to rewrite it`,
    );
    return 1;
  }
  writeFileSync(path, themeTokensCss());
  console.log(`rewrote ${THEME_TOKENS_CSS}`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
