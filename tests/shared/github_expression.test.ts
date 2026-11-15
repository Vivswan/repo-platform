// The helpers every workflow test reads `${{ }}` through. Each row is a spelling GitHub accepts that a reader of the
// text gets wrong, so a typo in a shipped workflow would pass the test that judges it.

import { describe, expect, test } from "bun:test";
import { type ContextRead, contextReads, interpolate, parseExpression } from "./github_expression";

describe("interpolate", () => {
  test.each<{ name: string; text: string; context: Record<string, string>; filled: string }>([
    {
      name: "a value that holds an expression is text, never read again",
      text: "${{ env.FIRST }} ${{ env.SECOND }}",
      context: { "env.FIRST": "${{ env.SECOND }}", "env.SECOND": "x" },
      filled: "${{ env.SECOND }} x",
    },
    {
      name: "braces inside a string literal do not close the expression",
      text: "${{ env.FIRST == '}}' }}|${{ format('{0}}}', env.FIRST) }}|it''s",
      context: { "env.FIRST": "}}" },
      filled: "true|}}}|it''s",
    },
    {
      name: "a key nobody set fills as empty, as an unrun step's output does",
      text: "[${{ env.SECOND }}]",
      context: { "env.FIRST": "x" },
      filled: "[]",
    },
  ])("$name", ({ text, context, filled }) => {
    expect(interpolate(text, context)).toBe(filled);
  });

  test.each([
    { name: "an expression that never closes", text: "a ${{ env.FIRST", error: "never closed" },
    { name: "a context nobody gave", text: "${{ inputs.label }}", error: "'inputs'" },
  ])("$name is refused, not filled as text", ({ text, error }) => {
    expect(() => interpolate(text, { "env.FIRST": "x" })).toThrow(error);
  });
});

describe("contextReads", () => {
  test.each<{ name: string; source: string; reads: ContextRead[] }>([
    {
      name: "a bracket index is the dotted read it names",
      source: "steps['build'].outputs.path != steps . build . outputs [ 'path' ]",
      reads: [
        ["steps", "build", "outputs", "path"],
        ["steps", "build", "outputs", "path"],
      ],
    },
    {
      name: "a name deeper in a chain is no read of its own",
      source: "github.event.inputs.mode == 'steps.build.outputs.path'",
      reads: [["github", "event", "inputs", "mode"]],
    },
    {
      name: "a computed index is a gap in its chain and a read of its own",
      source: "contains(steps[env.PROBE].outputs.*, inputs.mode) && !cancelled()",
      reads: [
        ["steps", null, "outputs", null],
        ["env", "PROBE"],
        ["inputs", "mode"],
      ],
    },
    {
      name: "parentheses around a chain, a part of it, or its index name the same read",
      source: "(steps).build['outputs'][('path')] != ((steps.build).outputs.path)",
      reads: [
        ["steps", "build", "outputs", "path"],
        ["steps", "build", "outputs", "path"],
      ],
    },
  ])("$name", ({ source, reads }) => {
    expect(contextReads(parseExpression(source).tree)).toEqual(reads);
  });
});
