// The actions/shared/ zone contract: it ships on the build branch and its
// code runs where nothing was installed (copier's post-render hooks inside
// freshly rendered repositories, the composite actions before their own
// installs), so every module there must resolve with ZERO installation.
// This scan is what keeps the zone shippable: node builtins (node:-prefixed
// so the intent is explicit) and zone-internal relative imports only - a
// bare specifier ("zod", even bare "fs"), a parent-relative escape into an
// action's own sources, or a dynamic import this scan cannot read would all
// break silently only once a rendered repository runs the hook.
//
// The scan is the transpiler's, not a regex: Bun.Transpiler.scanImports
// parses the source, so comment-interrupted forms (`from/* */"zod"`) and
// literal dynamic import/require calls are all seen. Non-literal dynamic
// forms, which no static scan can resolve, are banned outright on the
// comment-stripped transform output.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, resolve } from "node:path";

const SHARED = resolve(import.meta.dir, "..", "..", "actions", "shared");

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** A node: specifier that actually resolves: the runtime's own verdict
 *  (node:module's isBuiltin), so "node:not-real" fails here instead of at
 *  hook time - and prefix-only builtins like "node:test", which the
 *  builtinModules ARRAY omits, still count. */
function nodeBuiltin(spec: string): boolean {
  return spec.startsWith("node:") && isBuiltin(spec);
}

describe("actions/shared stays dependency-free", () => {
  const files = readdirSync(SHARED).sort();
  const sources = files.filter((name) => name.endsWith(".ts"));

  test("the zone exists and this scan has sources to check (never vacuous)", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  test("no dependency manifests, installs, or shipped tests in the zone", () => {
    // package.json or bun.lock would make the zone install-shaped; a
    // *.test.ts would ship on the branch and import bun:test.
    expect(files.filter((name) => !name.endsWith(".ts"))).toEqual([]);
    expect(files.filter((name) => name.endsWith(".test.ts"))).toEqual([]);
    expect(existsSync(join(SHARED, "node_modules"))).toBe(false);
  });

  test.each(sources)("%s imports only node builtins and zone-internal modules", (name) => {
    // The transpiler rejects shebang lines; blank it out (keeping offsets)
    // rather than slicing, so nothing else moves.
    const source = readFileSync(join(SHARED, name), "utf-8").replace(/^#![^\n]*/, "");
    // Dynamic import/require in ANY form is banned: the literal ones are
    // pointless next to static imports, and a non-literal one cannot be
    // statically verified against the zone contract. Checked on the
    // transform output so a comment inside the call cannot hide it (the
    // transform also erases type-only imports, which cost nothing at run
    // time and are judged by the typecheck instead).
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
    // Accepts prefix-only builtins the builtinModules array omits, rejects
    // fakes and unprefixed builtins (the zone spells the prefix out).
    expect(nodeBuiltin("node:fs")).toBe(true);
    expect(nodeBuiltin("node:test")).toBe(true);
    expect(nodeBuiltin("node:not-real")).toBe(false);
    expect(nodeBuiltin("fs")).toBe(false);
  });
});
