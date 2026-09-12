// The one rule for a repository-relative path: files.yml's entry paths, link destinations, mirror targets, and the
// manifest's keys all pass through it, so a manifest key the sync would never write is refused by the same test that
// refused it at the declaration.
//
// DEPENDENCY-FREE ZONE (see grammar.ts): node builtins and zone-internal imports only.

/** The checkout root's own length plus the relative path must fit the
 *  runner's PATH_MAX (4096 on Linux) or a stat of the path throws instead
 *  of answering; no fleet path comes near this. */
const MAX_PATH_BYTES = 1024;

/** Why `path` cannot be a repository-relative file path, or null. */
export function pathProblem(path: string): string | null {
  if (path.startsWith("/")) return "is absolute";
  if (path.includes("\\")) return "contains a backslash";
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "carries an empty, '.', or '..' segment";
  }
  if (segments.some((segment) => segment.toLowerCase() === ".git")) return "carries a .git segment";
  if ([...path].some(isControl)) return "carries a control character";
  if (segments.some((segment) => Buffer.byteLength(segment) > 255)) {
    return "has a segment over 255 bytes";
  }
  if (Buffer.byteLength(path) > MAX_PATH_BYTES) return `is longer than ${MAX_PATH_BYTES} bytes`;
  return null;
}

function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}
