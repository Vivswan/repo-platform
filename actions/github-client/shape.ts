// The diagnosis names paths and issue codes, never received values: a payload can be target-derived, and the message lands in a public log.

import type { ZodType } from "zod";

/** A caller that prints a failure prints only this type: an unexpected exception's message was not written value-free,
 * so it keeps its stack instead of masquerading as a payload diagnosis. */
export class JsonShapeError extends Error {}

/** `data` as the schema's type.
 *
 * @param label - what the diagnosis calls the payload
 * @throws {JsonShapeError} the payload does not match the schema
 */
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
