// Substitution runs on source files only, never on content read from a target repository.

export const PLACEHOLDER_NAMES = [
  "project_name",
  "project_slug",
  "description",
  "github_username",
  "github_username_lower",
  "copyright_holder",
  "year",
  "private",
  "fuzzer_label",
  "fuzzer_label_color",
  "fuzzer_label_description",
  "nightly_label",
  "nightly_label_color",
  "nightly_label_description",
  "site_label",
  "site_label_color",
  "site_label_description",
] as const;

export type PlaceholderName = (typeof PLACEHOLDER_NAMES)[number];

/** Partial: a name without a value is one no listed source uses, and the loader refuses a source that does. */
export type PlaceholderValues = Partial<Record<PlaceholderName, string>>;

export const BLOCKS_ANCHOR = "{{blocks}}";

// A `$` before the braces is a GitHub Actions expression (`${{ github.sha }}`), not a placeholder, and rides through untouched.
const TOKEN_RE = /(\$?)\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/** Substituted values land inside quoted YAML scalars verbatim, so a
 *  quote, a backslash, or a control character would change the document. */
const UNSAFE_VALUE_RE = /["\\\p{Cc}]/u;

export function isPlaceholderName(name: string): name is PlaceholderName {
  return (PLACEHOLDER_NAMES as readonly string[]).includes(name);
}

export function placeholderTokens(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    if (match[1] === "") names.push(match[2]);
  }
  return names;
}

export function unknownPlaceholders(text: string, allowed: readonly string[]): string[] {
  const unknown: string[] = [];
  for (const name of placeholderTokens(text)) {
    if (!allowed.includes(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}

export function blocksAnchorProblem(text: string): string | null {
  const mentions = text.split(BLOCKS_ANCHOR).length - 1;
  if (mentions === 0) return null;
  const lines = text.split("\n").filter((line) => line === BLOCKS_ANCHOR).length;
  if (mentions > 1) return `mentions ${BLOCKS_ANCHOR} more than once`;
  if (lines !== 1) return `mentions ${BLOCKS_ANCHOR} mid-line; it must be a line of its own`;
  return null;
}

/** Every piece ends in exactly one newline first, so the seams never merge two lines. */
export function spliceBlocks(text: string, blocks: string[]): string {
  const terminate = (piece: string) =>
    piece === "" || piece.endsWith("\n") ? piece : `${piece}\n`;
  const joined = blocks.map(terminate).join("");
  const lines = text.split("\n");
  const at = lines.indexOf(BLOCKS_ANCHOR);
  if (at === -1) return blocks.length === 0 ? text : terminate(text) + joined;
  const above = at === 0 ? "" : `${lines.slice(0, at).join("\n")}\n`;
  return `${above}${joined}${lines.slice(at + 1).join("\n")}`;
}

/** An empty value counts as missing: a license line without its holder is wrong, not blank. */
export function missingPlaceholders(text: string, values: PlaceholderValues): string[] {
  const missing: string[] = [];
  for (const name of placeholderTokens(text)) {
    const value = isPlaceholderName(name) ? values[name] : undefined;
    if ((value === undefined || value === "") && !missing.includes(name)) missing.push(name);
  }
  return missing;
}

/** The loader refuses a source with an unlisted token first, so that throw is a second gate; the unsafe-value throw is the only gate for a files.yml label default, which the registration grammar never sees. */
export function substitute(text: string, values: PlaceholderValues): string {
  return text.replace(TOKEN_RE, (whole, dollar: string, name: string) => {
    if (dollar !== "") return whole;
    const value = isPlaceholderName(name) ? values[name] : undefined;
    if (value === undefined) throw new Error(`unknown placeholder {{${name}}}`);
    if (UNSAFE_VALUE_RE.test(value)) {
      throw new Error(
        `placeholder {{${name}}}: its value carries a double quote, backslash, or control character`,
      );
    }
    return value;
  });
}
