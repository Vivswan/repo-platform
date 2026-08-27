// Boundary validation for external JSON (gh api responses, files handed
// between jobs): a malformed payload fails right here with a shape
// diagnosis instead of a confusing TypeError later. The diagnosis names
// paths and issue codes only - never received values, which can be
// target-derived (hide-details discipline).
//
// Two forms, one implementation: the throwing forms are for callers that
// own their failure containment (a fleet lane's malformed verdict must
// become that lane's failure row, never abort the whole run); the exiting
// forms are the default for scripts where any malformed payload is fatal.

import type { ZodType } from "zod";

/** The one error the throwing forms raise. exitOnThrow prints ONLY this
 * type, so an unexpected exception (a throwing zod transform, an fs
 * error) keeps its stack instead of masquerading as a payload diagnosis
 * - its message was not written under the value-free discipline. */
export class JsonShapeError extends Error {}

export function parseWithThrow<T>(schema: ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
      .join("; ");
    throw new JsonShapeError(`${label}: unexpected shape - ${issues}`);
  }
  return result.data;
}

/** JSON.parse with the same discipline: a raw SyntaxError echoes a
 * fragment of the offending text ("Unexpected identifier ..."), so the
 * invalid-JSON diagnostic is fixed and value-free like parseWithThrow's. */
export function parseJsonThrow(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new JsonShapeError(`${label}: not valid JSON`);
  }
}

/** Validate text that must first survive JSON.parse; both failure modes
 * throw with the value-free diagnostics above. */
export function parseJsonWithThrow<T>(schema: ZodType<T>, text: string, label: string): T {
  return parseWithThrow(schema, parseJsonThrow(text, label), label);
}

function exitOnThrow<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    if (!(err instanceof JsonShapeError)) throw err;
    console.log(`::error::${err.message}`);
    process.exit(1);
  }
}

export function parseWith<T>(schema: ZodType<T>, data: unknown, label: string): T {
  return exitOnThrow(() => parseWithThrow(schema, data, label));
}

export function parseJson(text: string, label: string): unknown {
  return exitOnThrow(() => parseJsonThrow(text, label));
}

export function parseJsonWith<T>(schema: ZodType<T>, text: string, label: string): T {
  return exitOnThrow(() => parseJsonWithThrow(schema, text, label));
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
