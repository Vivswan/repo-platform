// The fleet's repositories carry only markdown, so the routes, the locales, and what a page says about itself come from the files, never from a per-repo config.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { isLocaleDir, isUnwalkedEntry, owningRoot } from "./conventions.ts";

/** Only directories that carry markdown count. */
export function detectLocales(files: string[]): string[] {
  return [
    ...new Set(
      files
        .filter((file) => file.includes("/"))
        .map((file) => file.split("/")[0])
        .filter(isLocaleDir),
    ),
  ].sort();
}

export function walkMarkdown(srcDir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const name of readdirSync(join(srcDir, prefix)).sort()) {
    if (isUnwalkedEntry(name)) continue;
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    if (statSync(join(srcDir, rel)).isDirectory()) {
      files.push(...walkMarkdown(srcDir, rel));
    } else if (name.endsWith(".md")) {
      files.push(rel);
    }
  }
  return files;
}

/** VitePress's include directive expands only a regular file, so every stat failure is false. */
export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function includeIndexPages(
  files: string[],
  includes: { mount: string; page: string }[],
): string[] {
  return files.filter((file) => {
    const root = owningRoot(includes, file);
    if (root === undefined) return false;
    const parts = file.slice(root.mount.length + 1).split("/");
    return parts.length === 2 && parts[1] === root.page;
  });
}

/** An existing index.md, or an include page that already claimed it, wins; the README then keeps its own route. */
export function deriveRewrites(
  files: string[],
  indexPages: readonly string[] = [],
): Record<string, string> {
  const present = new Set(files);
  const rewrites: Record<string, string> = {};
  const claimed = new Set<string>();
  for (const file of indexPages) {
    if (!present.has(file)) continue;
    const index = file.replace(/[^/]+$/, "index.md");
    if (present.has(index) || claimed.has(index)) continue;
    rewrites[file] = index;
    claimed.add(index);
  }
  for (const file of files) {
    if (file !== "README.md" && !file.endsWith("/README.md")) continue;
    const index = file.replace(/README\.md$/, "index.md");
    if (!present.has(index) && !claimed.has(index)) rewrites[file] = index;
  }
  return rewrites;
}

/** `order` and `group` are the sidebar's frontmatter keys (docs/site.md). */
export interface PageMeta {
  title: string;
  order: number | null;
  group: string | null;
}

export function readPage(srcDir: string, file: string): PageMeta {
  return pageMeta(file, readFileSync(join(srcDir, file), "utf-8"));
}

/** `file` names the page in the error a malformed key raises, so a fleet repository's docs PR check points at it. */
export function pageMeta(file: string, source: string): PageMeta {
  const { data, content } = matter(source);
  const heading = /^#\s+(.+?)\s*$/m.exec(content)?.[1] ?? null;
  return {
    title: text(data.title) ?? heading ?? untitledPageTitle(file, data.name),
    order: frontmatterOrder(file, data.order),
    group: frontmatterGroup(file, data.group),
  };
}

/** The sidebar row (pageMeta) and the document title (config.mts transformPageData) both read it, so they agree. */
export function untitledPageTitle(file: string, name: unknown): string {
  const stem = file.split("/").pop()?.replace(/\.md$/, "") ?? file;
  return text(name) ?? stem.replace(/[-_]/g, " ");
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function frontmatterOrder(file: string, value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${file}: frontmatter 'order' must be a number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function frontmatterGroup(file: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `${file}: frontmatter 'group' must be a non-empty string, got ${JSON.stringify(value)}`,
    );
  }
  return value.trim();
}

/** Only an exact `index.md` basename is a directory index: `search-index.md` is an ordinary page, and a README the rewrite map skipped keeps its own route so the sidebar never points two files at one directory. */
export function routeOf(file: string, rewrites: Record<string, string>): string {
  const effective = rewrites[file] ?? file;
  const segments = effective.split("/");
  if (segments[segments.length - 1] === "index.md") {
    const dir = segments.slice(0, -1).join("/");
    return dir === "" ? "/" : `/${dir}/`;
  }
  return `/${effective.slice(0, -".md".length)}`;
}
