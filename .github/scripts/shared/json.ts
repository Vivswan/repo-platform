// Boundary validation for external JSON (gh api responses, files handed
// between jobs): a malformed payload fails right here with a shape
// diagnosis instead of a confusing TypeError later. The diagnosis names
// paths and issue codes only - never received values, which can be
// target-derived (hide-details discipline).

import type { ZodType } from "zod";

export function parseWith<T>(schema: ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
      .join("; ");
    console.log(`::error::${label}: unexpected shape - ${issues}`);
    process.exit(1);
  }
  return result.data;
}

/** JSON.parse with the same discipline: a raw SyntaxError echoes a
 * fragment of the offending text ("Unexpected identifier ..."), so the
 * invalid-JSON diagnostic is fixed and value-free like parseWith's. */
export function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    console.log(`::error::${label}: not valid JSON`);
    process.exit(1);
  }
}

/** Validate text that must first survive JSON.parse; both failure modes
 * exit here with the value-free diagnostics above. */
export function parseJsonWith<T>(schema: ZodType<T>, text: string, label: string): T {
  return parseWith(schema, parseJson(text, label), label);
}

/** True when any object in valid-JSON `text` declares the same key twice.
 * JSON.parse keeps only the LAST duplicate silently - a conflict-mangled
 * ownership manifest could reclassify an entry unseen. Keys compare
 * DECODED (JSON.parse's own collision, so escape variants are caught);
 * the caller must have JSON.parse'd `text`, so tokens are well-formed. */
export function hasDuplicateJsonKeys(text: string): boolean {
  /** keys === null marks an array frame (its strings are never keys). */
  type Frame = { keys: Set<string> | null; expectKey: boolean };
  const stack: Frame[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      const top = stack[stack.length - 1];
      if (top !== undefined && top.keys !== null && top.expectKey) {
        const key = JSON.parse(text.slice(start, i)) as string;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      continue;
    }
    if (ch === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (ch === "[") stack.push({ keys: null, expectKey: false });
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top !== undefined && top.keys !== null) top.expectKey = true;
    }
    i++;
  }
  return false;
}
