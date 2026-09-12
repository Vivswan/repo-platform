export interface Mismatch {
  file: string;
  expected: string;
  got: string;
}

export const MARKER_TOKENS = { begin: "BEGIN GENERATED:", end: "END GENERATED:" } as const;

/** A value inside a generated region has its generator as its author (files:check polices those),
 *  so a rule's doc-quoted constant must be found in hand prose. */
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

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

export function setMismatch(file: string, expected: string[], got: string[]): Mismatch[] {
  if (sortedSet(expected) === sortedSet(got)) return [];
  return [{ file, expected: sortedSet(expected), got: sortedSet(got) }];
}

export function orderedListMismatches(file: string, expected: string[], got: string[]): Mismatch[] {
  const mismatches: Mismatch[] = [];
  for (const name of expected) {
    if (!got.includes(name))
      mismatches.push({ file, expected: `'${name}' listed`, got: "missing" });
  }
  for (const name of got) {
    if (!expected.includes(name))
      mismatches.push({ file, expected: `no '${name}'`, got: "listed" });
  }
  const shared = expected.filter((name) => got.includes(name));
  const gotShared = got.filter((name) => expected.includes(name));
  if (shared.join(", ") !== gotShared.join(", ")) {
    mismatches.push({
      file,
      expected: `the order ${shared.join(", ")}`,
      got: gotShared.join(", "),
    });
  }
  return mismatches;
}

export function firstDiff(expected: string[], got: string[]): number {
  const max = Math.max(expected.length, got.length);
  for (let i = 0; i < max; i++) {
    if (expected[i] !== got[i]) return i;
  }
  return -1;
}
