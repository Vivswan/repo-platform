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
