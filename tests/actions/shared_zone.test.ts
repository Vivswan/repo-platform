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

/** The specifiers a source pulls in from outside the zone, plus the dynamic forms the contract bans outright: a
 *  non-literal dynamic import cannot be verified, and the check runs on the transform output so a comment inside the
 *  call cannot hide it and type-only imports (erased, judged by the typecheck) drop out. */
function offendersOf(source: string): string[] {
  const stripped = transpiler.transformSync(source);
  const dynamic = ["require(", "import("].filter((form) =>
    new RegExp(`\\b${form.replace("(", "\\s*\\(")}`).test(stripped),
  );
  const imports = transpiler
    .scanImports(source)
    .map((found) => found.path)
    .filter((spec) => !nodeBuiltin(spec) && !(spec.startsWith("./") && !spec.includes("..")));
  return [...dynamic, ...imports];
}

describe("actions/shared stays dependency-free", () => {
  const files = readdirSync(SHARED).sort();
  const sources = files.filter((name) => name.endsWith(".ts"));

  test("no dependency manifests, installs, or shipped tests in the zone; the scan names every offender of a synthetic source (the armed control)", () => {
    // package.json or bun.lock would make the zone install-shaped; a
    // *.test.ts would ship on the branch and import bun:test.
    expect(files.filter((name) => !name.endsWith(".ts"))).toEqual([]);
    expect(files.filter((name) => name.endsWith(".test.ts"))).toEqual([]);
    expect(existsSync(join(SHARED, "node_modules"))).toBe(false);
    // The per-source scan below yields zero cases on an empty list, so
    // this non-each test is what keeps it from passing vacuously.
    expect(sources.length).toBeGreaterThan(0);
    // A scan that found nothing would pass every real source too: this source carries one of each offence and one
    // of each accepted form, and the verdict is asserted whole.
    const armed = [
      'import { readFileSync } from "node:fs";',
      'import { test } from "node:test";',
      'import { z } from "zod";',
      'import { join } from "path";',
      'import { fake } from "node:not-real";',
      'import { up } from "../outside.ts";',
      'import { peer } from "./peer.ts";',
      'import type { Only } from "zod";',
      'const lazy = await import(/* c */ "./later.ts");',
      'const old = require("fs");',
    ].join("\n");
    expect(offendersOf(armed)).toEqual([
      "require(",
      "import(",
      "zod",
      "path",
      "node:not-real",
      "../outside.ts",
      "fs",
    ]);
  });

  test.each(sources)("%s imports only node builtins and zone-internal modules", (name) => {
    // The transpiler rejects shebang lines; blank it out (keeping offsets)
    // rather than slicing, so nothing else moves.
    const source = readFileSync(join(SHARED, name), "utf-8").replace(/^#![^\n]*/, "");
    expect(offendersOf(source)).toEqual([]);
  });
});
