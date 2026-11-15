// A token nobody reads is a customization point that cannot affect rendering, so every declared custom property needs a live var() reader.
// Carbon's :root and .dark reads of a property the theme redeclares are dead: the token layer loads after carbon at equal specificity and wins.
//   carbon vars.css `:root { --vp-button-alt-bg: var(--vp-c-default-3) }`  -> dead once the token layer sets --vp-button-alt-bg
//   carbon `.result.selected { ... }` reads                                -> live, a scoped rule still beats :root

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
import {
  MODES,
  modeValues,
  tokenNames,
} from "../../../actions/pages-site/.vitepress/theme/tokens.ts";

interface SfcBlock {
  content: string;
}

interface SfcParse {
  descriptor: {
    template: SfcBlock | null;
    script: SfcBlock | null;
    scriptSetup: SfcBlock | null;
    styles: SfcBlock[];
  };
  errors: Error[];
}

const ACTION = resolve(import.meta.dir, "../../../actions/pages-site");
const THEME = join(ACTION, ".vitepress/theme");
const CONFIG = join(ACTION, ".vitepress/config.mts");
const CARBON = join(ACTION, "node_modules/vitepress-carbon/dist");
const { createCssVariablesTheme } = (await import(Bun.resolveSync("shiki", ACTION))) as {
  createCssVariablesTheme: (options: { variablePrefix: string }) => unknown;
};
const { parse: parseSfc } = (await import(Bun.resolveSync("vue/compiler-sfc", ACTION))) as {
  parse: (source: string) => SfcParse;
};

const TEXT_VAR_READ = /var\(\s*(--[\w-]+)/g;
const ROOT_SELECTORS = new Set([":root", ".dark"]);

function filesUnder(dir: string, exts: string[]): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && exts.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The var() reads of text that is not CSS (script, template, JSON), where no CSS parser applies. */
function textReads(text: string): string[] {
  return [...text.matchAll(TEXT_VAR_READ)].map((match) => match[1]);
}

function valueReads(value: string): string[] {
  const reads: string[] = [];
  valueParser(value).walk((node) => {
    if (node.type !== "function" || node.value.toLowerCase() !== "var") return;

    const name = node.nodes.at(0);
    if (name?.type === "word") reads.push(name.value);
  });
  return reads;
}

function customProperties(css: string): string[] {
  const names: string[] = [];
  postcss.parse(css).walkDecls(/^--/, (declaration) => {
    names.push(declaration.prop);
  });
  return names;
}

/** Every var() a stylesheet reads, less the ones in a :root or .dark declaration of a property in `overridden`. */
function liveCssReads(css: string, overridden: ReadonlySet<string>): string[] {
  const live: string[] = [];
  postcss.parse(css).walkDecls((declaration) => {
    const rule = declaration.parent;
    const atRoot =
      rule?.type === "rule" && rule.selectors.every((selector) => ROOT_SELECTORS.has(selector));
    if (atRoot && overridden.has(declaration.prop)) return;

    live.push(...valueReads(declaration.value));
  });
  return live;
}

/** A carbon source by kind: a stylesheet and a component's style blocks are parsed as CSS; a component's
 *  template and script, and a .js module, are scanned as text, where every read is live. */
function liveCarbonReads(path: string, overridden: ReadonlySet<string>): string[] {
  const text = readFileSync(path, "utf-8");
  if (path.endsWith(".css")) return liveCssReads(text, overridden);
  if (!path.endsWith(".vue")) return textReads(text);

  const { descriptor, errors } = parseSfc(text);
  if (errors.length > 0) throw new Error(`${path}: ${errors[0].message}`);

  const code = [descriptor.template, descriptor.script, descriptor.scriptSetup];
  return [
    ...code.flatMap((block) => textReads(block?.content ?? "")),
    ...descriptor.styles.flatMap((style) => liveCssReads(style.content, overridden)),
  ];
}

/** Built the way config.mts builds it, so a renamed prefix or a token shiki stopped reading shows up as an unread declaration.
 *  `colored` is what a highlighted span can carry and so must be declared per mode; the rest of the theme need not be.
 *    editor background  -> never reaches a page (VitePress strips the pre's style)
 *    terminal palette   -> only inside an ansi fence, whose undeclared var() reads fall back to the code foreground */
function shikiReads(): { all: string[]; colored: string[] } {
  const prefix = readFileSync(CONFIG, "utf-8").match(/variablePrefix:\s*"(--[a-z0-9-]+)"/)?.[1];
  if (prefix === undefined) throw new Error("config.mts declares no shiki variablePrefix");
  const theme = createCssVariablesTheme({ variablePrefix: prefix }) as {
    colors: Record<string, string>;
    tokenColors: unknown[];
  };
  return {
    all: textReads(JSON.stringify(theme)),
    colored: textReads(JSON.stringify([theme.tokenColors, theme.colors["editor.foreground"]])),
  };
}

function themeDeclarations(): Set<string> {
  const declared = new Set<string>(tokenNames());
  for (const file of filesUnder(THEME, [".css"])) {
    for (const token of customProperties(readFileSync(file, "utf-8"))) declared.add(token);
  }
  return declared;
}

test("every custom property the theme declares has a live var() reader", () => {
  const declared = themeDeclarations();
  const read = new Set<string>();
  for (const file of filesUnder(THEME, [".css"])) {
    for (const token of liveCssReads(readFileSync(file, "utf-8"), new Set())) read.add(token);
  }
  for (const file of filesUnder(THEME, [".ts"])) {
    for (const token of textReads(readFileSync(file, "utf-8"))) read.add(token);
  }
  for (const file of filesUnder(CARBON, [".css", ".vue", ".js"])) {
    for (const token of liveCarbonReads(file, declared)) read.add(token);
  }
  const shiki = shikiReads();
  expect(shiki.colored).toContain("--fleet-code-token-comment");
  for (const token of shiki.all) read.add(token);
  const unread = [...declared].filter((token) => !read.has(token)).sort();
  expect(declared.size).toBeGreaterThan(50);
  expect(unread).toEqual([]);
  // The armed control: with the override filter disabled every token has a reader again and the sweep passes on dead
  // tokens, so the classification is pinned on a synthetic block and on the two shipped carbon cases it was written for.
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
  expect(liveCssReads(synthetic, new Set(["--a"])).sort()).toEqual(["--v", "--w", "--y"]);
  const vars = join(CARBON, "theme/styles/vars.css");
  expect(liveCarbonReads(vars, new Set())).toContain("--vp-c-default-3");
  expect(declared.has("--vp-button-alt-bg")).toBe(true);
  expect(liveCarbonReads(vars, declared)).not.toContain("--vp-c-default-3");
  const search = join(CARBON, "theme/components/VPLocalSearchBox.vue");
  expect(declared.has("--vp-local-search-result-bg")).toBe(true);
  expect(liveCarbonReads(search, declared)).toContain("--vp-local-search-result-selected-bg");
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

// The classification reads CSS as CSS: a reader that guesses rules from lines and braces loses a read or counts a dead one.
test.each([
  ["a one-line rule", ":root { --a: var(--x); --b: var(--y); }", ["--y"]],
  ["a brace inside a comment", ":root {\n  /* } */\n  --a: var(--x);\n}", []],
  ["an upper-case name", ".scoped { color: var(--Brand); }", ["--Brand"]],
])("the live reads of %s are the ones a browser resolves", (_shape, css, live) => {
  expect(liveCssReads(css, new Set(["--a"]))).toEqual(live);
});
