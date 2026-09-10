// The placeholder grammar of the files/ tree: `{{name}}` tokens, no spaces,
// from the fixed list below. A `$` before the braces marks a GitHub Actions
// expression (`${{ github.sha }}`), which is not a placeholder and rides
// through untouched. Substitution runs on source files only, never on
// content read from a target repository.

export const PLACEHOLDER_NAMES = [
  "project_name",
  "project_slug",
  "description",
  "github_username",
  "github_username_lower",
  "copyright_holder",
  "year",
] as const;

export type PlaceholderName = (typeof PLACEHOLDER_NAMES)[number];

export type PlaceholderValues = Record<PlaceholderName, string>;

const TOKEN_RE = /(\$?)\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

export function isPlaceholderName(name: string): name is PlaceholderName {
  return (PLACEHOLDER_NAMES as readonly string[]).includes(name);
}

/** Every placeholder-shaped token in `text`, in order, duplicates included. */
export function placeholderTokens(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    if (match[1] === "") names.push(match[2]);
  }
  return names;
}

/** The token names in `text` outside `allowed`, deduplicated, in order. */
export function unknownPlaceholders(text: string, allowed: readonly string[]): string[] {
  const unknown: string[] = [];
  for (const name of placeholderTokens(text)) {
    if (!allowed.includes(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}

/** `text` with every placeholder token replaced; throws on a token outside
 *  `values` (the loader rejects such sources first, so this is the writer's
 *  own guard, not a user-facing message). */
export function substitute(text: string, values: PlaceholderValues): string {
  return text.replace(TOKEN_RE, (whole, dollar: string, name: string) => {
    if (dollar !== "") return whole;
    if (!isPlaceholderName(name)) throw new Error(`unknown placeholder {{${name}}}`);
    return values[name];
  });
}
