// Where a rendered page's source lives in the repository. config.mts
// rewrites every page's filePath through it, so the edit link's `:path`
// and the provenance line name the same file without either knowing the
// staging layout.

/** The landing-page source names: a README.md (the fleet convention) or an
 *  index.md, at any depth. An include root's page file is not one - it
 *  serves at its directory URL but stays an article. */
const LANDING_FILES = new Set(["README.md", "index.md"]);

export function isLandingFile(filePath: string): boolean {
  return LANDING_FILES.has(filePath.split("/").pop() ?? "");
}

/** The longest mount wins, so a root mounted inside another's segment resolves to itself. */
export function sourcePathOf(
  docsDir: string,
  includes: readonly { path: string; mount: string }[],
  filePath: string,
): string {
  const root = includes
    .filter((include) => filePath.startsWith(`${include.mount}/`))
    .sort((a, b) => b.mount.length - a.mount.length)[0];
  if (root === undefined) return `${docsDir}/${filePath}`;
  return `${root.path}/${filePath.slice(root.mount.length + 1)}`;
}
