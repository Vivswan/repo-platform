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
  "skills_dir",
  "fuzzer_label",
  "nightly_label",
  "site_label",
] as const;

export type PlaceholderName = (typeof PLACEHOLDER_NAMES)[number];

/** The values a run can substitute; a name without a value here is one no
 *  listed source uses (the loader refuses a source using it). */
export type PlaceholderValues = Partial<Record<PlaceholderName, string>>;

/** The line, on its own, where an entry's block files are spliced into its
 *  source; a source without one gets them appended at the end. */
export const BLOCKS_ANCHOR = "{{blocks}}";

const TOKEN_RE = /(\$?)\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/** Substituted values land inside quoted YAML scalars verbatim, so a
 *  quote, a backslash, or a control character would change the document. */
const UNSAFE_VALUE_RE = /["\\\p{Cc}]/u;

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

/** Why `text` cannot carry the blocks anchor as written, or null: the
 *  anchor may appear at most once, and only as a whole line. */
export function blocksAnchorProblem(text: string): string | null {
  const mentions = text.split(BLOCKS_ANCHOR).length - 1;
  if (mentions === 0) return null;
  const lines = text.split("\n").filter((line) => line === BLOCKS_ANCHOR).length;
  if (mentions > 1) return `mentions ${BLOCKS_ANCHOR} more than once`;
  if (lines !== 1) return `mentions ${BLOCKS_ANCHOR} mid-line; it must be a line of its own`;
  return null;
}

/** `text` with the block bodies spliced in at the anchor line, or appended
 *  when there is none (a text without anchor or blocks is returned as is).
 *  Every piece ends in exactly one newline first, so the seams never merge
 *  two lines. */
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

/** The placeholder names in `text` whose value is absent or empty, once
 *  each in order: an empty value is never written (a license line without
 *  its holder is wrong, not blank). */
export function missingPlaceholders(text: string, values: PlaceholderValues): string[] {
  const missing: string[] = [];
  for (const name of placeholderTokens(text)) {
    const value = isPlaceholderName(name) ? values[name] : undefined;
    if ((value === undefined || value === "") && !missing.includes(name)) missing.push(name);
  }
  return missing;
}

/** `text` with every placeholder token replaced; throws on a token outside
 *  `values` (the loader rejects such sources first, so this is the writer's
 *  own guard, not a user-facing message) and on a value that would break
 *  the quoted scalar it lands in (the registration grammar refuses those
 *  first; this is the second gate). */
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
