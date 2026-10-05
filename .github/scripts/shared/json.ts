// The diagnosis names paths and issue codes, never received values: a payload can be target-derived, and the message lands in a public log.
// The throwing forms exist for callers that contain their own failures
// (a fleet lane's malformed verdict becomes that lane's failure row, not the run's abort).

import type { ZodType } from "zod";

/** exitOnThrow prints only this type: an unexpected exception's message was not written value-free,
 * so it keeps its stack instead of masquerading as a payload diagnosis. */
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
