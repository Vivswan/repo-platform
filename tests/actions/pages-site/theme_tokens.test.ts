// The theme's token layer is a set of --vp-* values carbon reads; a token
// nobody reads is a customization point that cannot affect rendering. This
// pins every declaration in the theme's CSS to at least one live var()
// consumer: one in the theme's own files, or one in carbon's shipped theme
// that the theme's own declarations do not outrank. Carbon's :root and
// .dark token declarations lose to the theme's redeclaration of the same
// property (custom.css loads after carbon at equal specificity), so
// `--vp-button-alt-bg: var(--vp-c-default-3)` in carbon's vars.css stops
// reading --vp-c-default-3 once custom.css sets --vp-button-alt-bg itself;
// a scoped redeclaration such as carbon's `.result.selected { ... }` still
// wins over :root and keeps reading.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const THEME = resolve(import.meta.dir, "../../../actions/pages-site/.vitepress/theme");
const CARBON = resolve(
  import.meta.dir,
  "../../../actions/pages-site/node_modules/vitepress-carbon/dist",
);

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

function themeDeclarations(themeFiles: string[]): Set<string> {
  const declared = new Set<string>();
  for (const file of themeFiles.filter((f) => f.endsWith(".css"))) {
    for (const token of tokens(readFileSync(file, "utf-8"), DECLARATION)) declared.add(token);
  }
  return declared;
}

test("every custom property the theme declares has a live var() reader", () => {
  const themeFiles = filesUnder(THEME, [".css", ".ts"]);
  const declared = themeDeclarations(themeFiles);
  const read = new Set<string>();
  for (const file of themeFiles) {
    for (const token of tokens(readFileSync(file, "utf-8"), VAR_READ)) read.add(token);
  }
  for (const file of filesUnder(CARBON, [".css", ".vue", ".js"])) {
    for (const token of liveCarbonReads(readFileSync(file, "utf-8"), declared)) read.add(token);
  }
  const unread = [...declared].filter((token) => !read.has(token)).sort();
  expect(declared.size).toBeGreaterThan(50);
  expect(unread).toEqual([]);
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

  const declared = themeDeclarations(filesUnder(THEME, [".css"]));
  const vars = readFileSync(join(CARBON, "theme/styles/vars.css"), "utf-8");
  expect(tokens(vars, VAR_READ)).toContain("--vp-c-default-3");
  expect(declared.has("--vp-button-alt-bg")).toBe(true);
  expect(liveCarbonReads(vars, declared)).not.toContain("--vp-c-default-3");
  const search = readFileSync(join(CARBON, "theme/components/VPLocalSearchBox.vue"), "utf-8");
  expect(declared.has("--vp-local-search-result-bg")).toBe(true);
  expect(liveCarbonReads(search, declared)).toContain("--vp-local-search-result-selected-bg");
});
