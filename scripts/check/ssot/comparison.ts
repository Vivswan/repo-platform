export interface Mismatch {
  file: string;
  expected: string;
  got: string;
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
