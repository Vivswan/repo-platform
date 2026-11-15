// The throwing forms exist for callers that contain their own failures
// (a fleet lane's malformed verdict becomes that lane's failure row, not the run's abort).

import { error } from "@actions/core";
import type { ZodType } from "zod";
import { JsonShapeError, parseWithThrow } from "../../../actions/github-client/shape.ts";

/** JSON.parse with parseWithThrow's discipline: a raw SyntaxError echoes a
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
    error(err.message);
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
