// The Mismatch shape every rule reports, the recorded divergences, and the
// comparison primitives (semantic lines, canonical JSON, set and line diffs,
// loud anchors) the rule modules under this directory build on.

import { MARKER_TOKENS } from "../../generate/markers.ts";

export interface Mismatch {
  file: string;
  expected: string;
  got: string;
}

// Intentional, recorded divergences between a repo file and its templates/
// counterpart. A divergence means exactly one thing: the OPERATOR copy
// carries a line the template lacks. Each entry excuses, from the operator
// side only, AT MOST ONE line matching `skip` sitting immediately before a
// line matching `before` (both matched against trimmed lines, after
// semanticLines dropped comments and blanks): a second copy, or the same
// line migrated elsewhere, still mismatches. A template side that carries
// the same anchored line makes the entry stale - reported, with nothing
// excused - so the excuse can never mask the template catching up. Honored
// only by the semantic-mode dogfood-parity pairs - the prefix-mode pairs
// compare their template prefix verbatim and cannot skip lines - and
// subset rules already tolerate repo-side additions without an entry.
// Every entry must say why the divergence is deliberate; an entry that
// excused nothing anywhere is reported as stale.
export const RECORDED_DIVERGENCES: {
  file: string;
  reason: string;
  skip: RegExp;
  before: RegExp;
}[] = [];

/** A markdown doc with its generated regions removed (and how many), so a
 *  doc-quoted constant must live in HAND prose to satisfy a rule: a value
 *  inside a generated region has the manifests as its author
 *  (generate:check polices those). The marker grammar is built from
 *  scripts/generate/markers.ts's MARKER_TOKENS, so renaming the marker text there
 *  cannot leave this stripper matching nothing. Markers are parsed
 *  pairwise - a duplicate BEGIN, a mismatched name, a dangling END, or an
 *  unclosed region all throw. */
export function stripGeneratedRegions(
  text: string,
  where: string,
): { prose: string; regions: number } {
  const marker = new RegExp(
    `<!-- (${MARKER_TOKENS.begin}|${MARKER_TOKENS.end}) ([a-z0-9-]+)[^>]*-->`,
    "g",
  );
  let out = "";
  let cursor = 0;
  let regions = 0;
  let open: { name: string; at: number } | null = null;
  for (const match of text.matchAll(marker)) {
    const [full, kind, name] = match;
    if (kind === MARKER_TOKENS.begin) {
      if (open) {
        throw new Error(
          `${where}: generated region '${open.name}' is still open where '${name}' begins`,
        );
      }
      open = { name, at: match.index };
      out += text.slice(cursor, match.index);
      cursor = match.index;
    } else {
      if (!open) throw new Error(`${where}: END marker for '${name}' has no matching BEGIN`);
      if (open.name !== name) {
        throw new Error(`${where}: region '${open.name}' is closed by END '${name}'`);
      }
      open = null;
      regions++;
      cursor = match.index + full.length;
    }
  }
  if (open) throw new Error(`${where}: generated region '${open.name}' is never closed`);
  out += text.slice(cursor);
  if (out.includes(MARKER_TOKENS.begin) || out.includes(MARKER_TOKENS.end)) {
    throw new Error(`${where}: malformed generated-region markers remain after stripping`);
  }
  return { prose: out, regions };
}

/** Anchor extraction that fails loudly: a missing match means the fact this
 *  rule keys on moved or was deleted, which must never pass silently. */
export function mustMatch(text: string, re: RegExp, where: string, what: string): RegExpExecArray {
  const match = re.exec(text);
  if (!match) throw new Error(`${where}: anchor for ${what} not found (pattern ${re})`);
  return match;
}

/** `text` as a regex fragment matching itself: every metacharacter,
 *  the backslash included, escaped. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Non-blank, non-comment lines (right-trimmed) - the shape compared for
 *  workflow/dotfile parity, where comments are where copies legitimately
 *  tell their own story. */
export function semanticLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
}

export const usedDivergences = new Set<number>();

/** Excuse recorded divergences for one parity pair: drop, from the ACTUAL
 *  (operator) side only, at most one line per entry matching `skip` that
 *  sits immediately before a line matching `before`. When the EXPECTED
 *  (template) side carries the same anchored line, the entry is stale -
 *  returned as a mismatch with nothing excused, so both sides keep the
 *  line and the drift is named instead of silently excused twice. Entries
 *  and the used-set are injectable for tests. */
export function applyDivergences(
  file: string,
  expected: string[],
  actual: string[],
  entries: typeof RECORDED_DIVERGENCES = RECORDED_DIVERGENCES,
  used: Set<number> = usedDivergences,
): { expected: string[]; actual: string[]; mismatches: Mismatch[] } {
  const mismatches: Mismatch[] = [];
  const drop = new Set<number>();
  const findAnchored = (lines: string[], entry: (typeof entries)[number], taken?: Set<number>) =>
    lines.findIndex(
      (line, i) =>
        !taken?.has(i) &&
        entry.skip.test(line.trim()) &&
        entry.before.test(lines[i + 1]?.trim() ?? ""),
    );
  for (const [index, entry] of entries.entries()) {
    if (entry.file !== file) continue;
    if (findAnchored(expected, entry) !== -1) {
      used.add(index);
      mismatches.push({
        file,
        expected: `no template line matching ${entry.skip} before ${entry.before}`,
        got: "the template now carries this line - drop the RECORDED_DIVERGENCES entry",
      });
      continue;
    }
    const at = findAnchored(actual, entry, drop);
    if (at === -1) continue;
    drop.add(at);
    used.add(index);
  }
  return {
    expected,
    actual: drop.size === 0 ? actual : actual.filter((_, i) => !drop.has(i)),
    mismatches,
  };
}

/** JSON with recursively sorted object keys, for order-insensitive
 *  deep-equality messages. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sortedSet(values: string[]): string {
  return [...new Set(values)].sort().join(", ");
}

/** One mismatch when `got` is not exactly the same set as `expected`. */
export function setMismatch(file: string, expected: string[], got: string[]): Mismatch[] {
  if (sortedSet(expected) === sortedSet(got)) return [];
  return [{ file, expected: sortedSet(expected), got: sortedSet(got) }];
}

/** First index where two line sequences differ, or -1 when equal. */
export function firstDiff(expected: string[], got: string[]): number {
  const max = Math.max(expected.length, got.length);
  for (let i = 0; i < max; i++) {
    if (expected[i] !== got[i]) return i;
  }
  return -1;
}
