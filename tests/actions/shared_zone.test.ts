// actions/shared runs from the delivery commit before any install, so every module there must resolve with zero installation.
// The scan is Bun.Transpiler's, not a regex: a regex misses `from/* */"zod"`.
//   bare "zod"  -> breaks only once a rendered repository runs the hook
//   bare "fs"   -> resolves, but is refused so the builtin intent is explicit (node:fs)

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, resolve } from "node:path";

const SHARED = resolve(import.meta.dir, "..", "..", "actions", "shared");

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** isBuiltin, not the builtinModules array: the array omits prefix-only builtins like "node:test".
 *  "node:not-real" must fail here rather than at hook time. */
function nodeBuiltin(spec: string): boolean {
  return spec.startsWith("node:") && isBuiltin(spec);
}

describe("actions/shared stays dependency-free", () => {
  const files = readdirSync(SHARED).sort();
  const sources = files.filter((name) => name.endsWith(".ts"));

  test("no dependency manifests, installs, or shipped tests in the zone", () => {
    // package.json or bun.lock would make the zone install-shaped; a
    // *.test.ts would ship on the branch and import bun:test.
    expect(files.filter((name) => !name.endsWith(".ts"))).toEqual([]);
    expect(files.filter((name) => name.endsWith(".test.ts"))).toEqual([]);
    expect(existsSync(join(SHARED, "node_modules"))).toBe(false);
    // The per-source scan below yields zero cases on an empty list, so
    // this non-each test is what keeps it from passing vacuously.
    expect(sources.length).toBeGreaterThan(0);
  });

  test.each(sources)("%s imports only node builtins and zone-internal modules", (name) => {
    // The transpiler rejects shebang lines; blank it out (keeping offsets)
    // rather than slicing, so nothing else moves.
    const source = readFileSync(join(SHARED, name), "utf-8").replace(/^#![^\n]*/, "");
    // A non-literal dynamic import cannot be verified against the zone contract, so dynamic forms are banned outright.
    // Checked on the transform output: a comment inside the call cannot hide it, and type-only imports (erased, judged by the typecheck) drop out.
    const stripped = transpiler.transformSync(source);
    expect(stripped).not.toMatch(/\brequire\s*\(/);
    expect(stripped).not.toMatch(/\bimport\s*\(/);
    const offenders = transpiler
      .scanImports(source)
      .map((found) => found.path)
      .filter((spec) => !nodeBuiltin(spec) && !(spec.startsWith("./") && !spec.includes("..")));
    expect(offenders).toEqual([]);
  });

  test("the builtin predicate is the runtime's own verdict (controls)", () => {
    expect(nodeBuiltin("node:fs")).toBe(true);
    expect(nodeBuiltin("node:test")).toBe(true);
    expect(nodeBuiltin("node:not-real")).toBe(false);
    expect(nodeBuiltin("fs")).toBe(false);
  });
});
