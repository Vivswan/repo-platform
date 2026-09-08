// The theme's token layer is a set of --vp-* values carbon reads; a token
// nobody reads is a customization point that cannot affect rendering. This
// pins every declaration in the theme's CSS to at least one var() consumer
// in carbon's shipped theme or in the theme's own files.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const THEME = resolve(import.meta.dir, "../../../actions/pages-site/.vitepress/theme");
const CARBON = resolve(
  import.meta.dir,
  "../../../actions/pages-site/node_modules/vitepress-carbon/dist",
);

function filesUnder(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, exts));
    else if (exts.some((ext) => entry.endsWith(ext))) out.push(path);
  }
  return out;
}

test("every custom property the theme declares has a var() reader", () => {
  const themeFiles = filesUnder(THEME, [".css", ".ts"]);
  const declared = new Set<string>();
  for (const file of themeFiles.filter((f) => f.endsWith(".css"))) {
    for (const match of readFileSync(file, "utf-8").matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)) {
      declared.add(match[1]);
    }
  }
  const consumers = [...themeFiles, ...filesUnder(CARBON, [".css", ".vue", ".js"])];
  const read = new Set<string>();
  for (const file of consumers) {
    for (const match of readFileSync(file, "utf-8").matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
      read.add(match[1]);
    }
  }
  const unread = [...declared].filter((token) => !read.has(token)).sort();
  expect(declared.size).toBeGreaterThan(50);
  expect(unread).toEqual([]);
});
