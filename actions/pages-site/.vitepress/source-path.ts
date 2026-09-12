// Where a rendered page's source lives in the repository. config.mts
// rewrites every page's filePath through it, so the edit link's `:path`
// and the provenance line name the same file without either knowing the
// staging layout.

import { owningRoot } from "./conventions.ts";

const LANDING_FILES = new Set(["README.md", "index.md"]);

/** An include root's page file (`includePages`, includeIndexPages) serves
 *  at its directory URL like a README but stays an article, even when the
 *  root names README.md as its page. */
export function isLandingFile(filePath: string, includePages: ReadonlySet<string>): boolean {
  return !includePages.has(filePath) && LANDING_FILES.has(filePath.split("/").pop() ?? "");
}

export function sourcePathOf(
  docsDir: string,
  includes: readonly { path: string; mount: string }[],
  filePath: string,
): string {
  const root = owningRoot(includes, filePath);
  if (root === undefined) return `${docsDir}/${filePath}`;
  return `${root.path}/${filePath.slice(root.mount.length + 1)}`;
}
