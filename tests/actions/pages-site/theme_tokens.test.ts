// The theme's token layer is a set of --vp-* values carbon reads; a token
// nobody reads is a customization point that cannot affect rendering. This
// pins every token tokens.ts declares, and every custom property the
// hand-written CSS declares, to at least one live var() consumer: one in
// the theme's own files, or one in carbon's shipped theme that the theme's
// own declarations do not outrank. Carbon's :root and .dark token
// declarations lose to the theme's redeclaration of the same property
// (tokens.css loads after carbon at equal specificity), so
// `--vp-button-alt-bg: var(--vp-c-default-3)` in carbon's vars.css stops
// reading --vp-c-default-3 once tokens.css sets --vp-button-alt-bg itself;
// a scoped redeclaration such as carbon's `.result.selected { ... }` still
// wins over :root and keeps reading. The code palette (--fleet-code-*) has
// one more reader: the shiki css-variables theme config.mts installs, whose
// token colors are var() reads of those names in the highlighted HTML.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  MODES,
  modeValues,
  tokenNames,
} from "../../../actions/pages-site/.vitepress/theme/tokens.ts";

const ACTION = resolve(import.meta.dir, "../../../actions/pages-site");
const THEME = join(ACTION, ".vitepress/theme");
const CONFIG = join(ACTION, ".vitepress/config.mts");
const CARBON = join(ACTION, "node_modules/vitepress-carbon/dist");
/** The rendering of tokens.ts; its declarations are the data's, not the file's. */
const GENERATED_CSS = join(THEME, "tokens.css");
// shiki is the action's dependency, not the root's.
const { createCssVariablesTheme } = (await import(Bun.resolveSync("shiki", ACTION))) as {
  createCssVariablesTheme: (options: { variablePrefix: string }) => unknown;
};

const DECLARATION = /^\s*(--[a-z0-9-]+)\s*:([^;]*)/gm;
const VAR_READ = /var\(\s*(--[a-z0-9-]+)/g;
const ROOT_SELECTORS = new Set([":root", ".dark"]);

function filesUnder(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, exts));
    else if (exts.some((ext) => entry.endsWith(ext))) out.push(path);
  }
  return out;
}

function tokens(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

/** The var() reads in carbon's `text` that survive the theme's overrides:
 *  every read except those inside a :root or .dark declaration of a
 *  property the theme redeclares. */
function liveCarbonReads(text: string, overridden: Set<string>): string[] {
  const live: string[] = [];
  for (const block of text.split("}")) {
    const brace = block.lastIndexOf("{");
    const selector = block.slice(0, brace).trim().split("\n").at(-1)?.trim() ?? "";
    const body = block.slice(brace + 1);
    live.push(...tokens(block.slice(0, brace + 1), VAR_READ));
    if (!ROOT_SELECTORS.has(selector)) {
      live.push(...tokens(body, VAR_READ));
      continue;
    }
    for (const match of body.matchAll(DECLARATION)) {
      if (!overridden.has(match[1])) live.push(...tokens(match[2], VAR_READ));
    }
  }
  return live;
}

/** The var() reads shiki emits for the prefix config.mts hands it: the
 *  theme is built the way config.mts builds it, so a renamed prefix or a
 *  token shiki stopped reading shows up here as an unread declaration.
 *  `colored` is the subset every highlighted span can carry (the token
 *  colors and the default foreground) and so must be declared per mode.
 *  The editor background never reaches a page (VitePress strips the pre's
 *  style), and the terminal palette only through an ansi fence, whose
 *  undeclared var() reads fall back to the code foreground. */
function shikiReads(): { all: string[]; colored: string[] } {
  const prefix = readFileSync(CONFIG, "utf-8").match(/variablePrefix:\s*"(--[a-z0-9-]+)"/)?.[1];
  if (prefix === undefined) throw new Error("config.mts declares no shiki variablePrefix");
  const theme = createCssVariablesTheme({ variablePrefix: prefix }) as {
    colors: Record<string, string>;
    tokenColors: unknown[];
  };
  return {
    all: tokens(JSON.stringify(theme), VAR_READ),
    colored: tokens(
      JSON.stringify([theme.tokenColors, theme.colors["editor.foreground"]]),
      VAR_READ,
    ),
  };
}

/** Every custom property the theme declares: the token layer's names from
 *  tokens.ts, plus the component-scoped ones the hand-written CSS sets. */
function themeDeclarations(): Set<string> {
  const declared = new Set<string>(tokenNames());
  for (const file of filesUnder(THEME, [".css"])) {
    if (file === GENERATED_CSS) continue;
    for (const token of tokens(readFileSync(file, "utf-8"), DECLARATION)) declared.add(token);
  }
  return declared;
}

test("every custom property the theme declares has a live var() reader", () => {
  const declared = themeDeclarations();
  const read = new Set<string>();
  for (const file of filesUnder(THEME, [".css", ".ts"])) {
    for (const token of tokens(readFileSync(file, "utf-8"), VAR_READ)) read.add(token);
  }
  for (const file of filesUnder(CARBON, [".css", ".vue", ".js"])) {
    for (const token of liveCarbonReads(readFileSync(file, "utf-8"), declared)) read.add(token);
  }
  const shiki = shikiReads();
  expect(shiki.colored).toContain("--fleet-code-token-comment");
  for (const token of shiki.all) read.add(token);
  const unread = [...declared].filter((token) => !read.has(token)).sort();
  expect(declared.size).toBeGreaterThan(50);
  expect(unread).toEqual([]);
});

// The reverse: a color shiki can put on a span (a diff fence's inserted
// and deleted lines, a link) with no declared value falls back to the
// plain text ink, so every colored variable must have a value in each mode,
// the print sheet's included.
test.each([...MODES])("every token color the shiki theme emits has a %s value", (mode) => {
  const declared = new Set<string>(modeValues(mode).keys());
  const undeclared = [...new Set(shikiReads().colored)].filter((token) => !declared.has(token));
  expect(undeclared).toEqual([]);
});

// The control for the filter above: with the override rule disabled every
// token has a reader again and the first test passes on dead tokens, so
// this pins the classification on a synthetic block and on the two shipped
// carbon cases it was written for.
test("the override filter drops :root reads the theme outranks and keeps scoped ones", () => {
  const synthetic = [
    ":root {",
    "  --a: var(--x);",
    "  --b: var(--y);",
    "}",
    ".dark {",
    "  --a: var(--z);",
    "}",
    ".scoped {",
    "  --a: var(--w);",
    "  color: var(--v);",
    "}",
  ].join("\n");
  expect(liveCarbonReads(synthetic, new Set(["--a"])).sort()).toEqual(["--v", "--w", "--y"]);

  const declared = themeDeclarations();
  const vars = readFileSync(join(CARBON, "theme/styles/vars.css"), "utf-8");
  expect(tokens(vars, VAR_READ)).toContain("--vp-c-default-3");
  expect(declared.has("--vp-button-alt-bg")).toBe(true);
  expect(liveCarbonReads(vars, declared)).not.toContain("--vp-c-default-3");
  const search = readFileSync(join(CARBON, "theme/components/VPLocalSearchBox.vue"), "utf-8");
  expect(declared.has("--vp-local-search-result-bg")).toBe(true);
  expect(liveCarbonReads(search, declared)).toContain("--vp-local-search-result-selected-bg");
});
