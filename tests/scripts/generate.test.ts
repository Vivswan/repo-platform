// Unit tests for the umbrella generator's pure pieces: the marker-region
// splice and the region-body builders. The live-repo byte-identity of the
// generated regions is proven by `bun run generate:check`, not here.

import { describe, expect, test } from "bun:test";
import {
  hasToolchainDefault,
  knownModules,
  markerLines,
  moduleChoices,
  type PagesManifest,
  pagesBuildCommand,
  pagesInstallCommand,
  pagesManifests,
  pagesSetup,
  spliceRegion,
} from "../../scripts/generate";
import type { ModuleManifest } from "../../scripts/module_manifests";

function manifest(module: string, extra: Partial<ModuleManifest> = {}): ModuleManifest {
  return { module, description: `${module} module`, ...extra };
}

const BUN = manifest("bun", {
  description: "TypeScript/bun toolchain",
  toolchain: { codeql_language: "javascript-typescript" },
  pages: { install: "bun install --frozen-lockfile", build: "bun run build" },
}) as PagesManifest;
const UV = manifest("uv", {
  description: "Python/uv toolchain",
  toolchain: { codeql_language: "python" },
  pages: { install: "uv sync", build: "uv run mkdocs build --site-dir dist" },
}) as PagesManifest;
const RUST = manifest("rust", { description: "Rust/cargo toolchain" });

describe("spliceRegion", () => {
  const { begin, end } = markerLines("demo", "#");
  const text = ["head:", `  ${begin}`, "  old: 1", `  ${end}`, "tail:", ""].join("\n");

  test("replaces the lines between the markers, keeping the markers verbatim", () => {
    const next = spliceRegion(text, "f.yml", "demo", "#", ["  new: 2", "  more: 3"]);
    expect(next).toBe(
      ["head:", `  ${begin}`, "  new: 2", "  more: 3", `  ${end}`, "tail:", ""].join("\n"),
    );
  });

  test("is idempotent", () => {
    const once = spliceRegion(text, "f.yml", "demo", "#", ["  new: 2"]);
    expect(spliceRegion(once, "f.yml", "demo", "#", ["  new: 2"])).toBe(once);
  });

  test("a missing marker pair throws, naming file and region", () => {
    expect(() => spliceRegion("no markers\n", "f.yml", "demo", "#", [])).toThrow("f.yml");
    expect(() => spliceRegion("no markers\n", "f.yml", "demo", "#", [])).toThrow("'demo'");
  });

  test("a duplicated marker throws", () => {
    expect(() => spliceRegion(`${text}${begin}\n`, "f.yml", "demo", "#", [])).toThrow(
      "exactly one",
    );
  });

  test("an END before BEGIN throws", () => {
    const swapped = [end, "body", begin, ""].join("\n");
    expect(() => spliceRegion(swapped, "f.yml", "demo", "#", [])).toThrow("before BEGIN");
  });

  test("a marker with trailing prose does not count as the marker", () => {
    const decorated = text.replace(`  ${end}`, `  ${end} (moved)`);
    expect(() => spliceRegion(decorated, "f.yml", "demo", "#", [])).toThrow("exactly one");
  });
});

describe("region builders", () => {
  test("moduleChoices renders one `<module> - <description>: <module>` line each", () => {
    expect(moduleChoices([BUN, RUST])).toEqual([
      "  choices:",
      "    bun - TypeScript/bun toolchain: bun",
      "    rust - Rust/cargo toolchain: rust",
    ]);
  });

  test("hasToolchainDefault or-chains the toolchain manifests only", () => {
    expect(hasToolchainDefault([BUN, UV, RUST])).toEqual([
      "  default: \"{{ 'bun' in modules or 'uv' in modules }}\"",
    ]);
    expect(hasToolchainDefault([BUN, RUST])).toEqual(["  default: \"{{ 'bun' in modules }}\""]);
    expect(() => hasToolchainDefault([RUST])).toThrow("declare toolchain");
  });

  test("pagesManifests filters to the pages-declaring modules and refuses none", () => {
    expect(pagesManifests([BUN, UV, RUST]).map((m) => m.module)).toEqual(["bun", "uv"]);
    expect(() => pagesManifests([RUST])).toThrow("pages: {install, build}");
  });

  test("pagesSetup builds the default union and the validator token list", () => {
    const [defaultLine, validatorLine] = pagesSetup([BUN, UV]);
    expect(defaultLine).toBe(
      "  default: \"{{ ((['bun'] if 'bun' in modules else []) + (['uv'] if 'uv' in modules else [])) | join(',') or 'none' }}\"",
    );
    expect(validatorLine).toContain("['bun', 'uv', 'none']");
    expect(validatorLine).toContain("pages_setup tokens must be bun, uv, or none");
  });

  test("a single pages module keeps the prose grammatical", () => {
    const [, validatorLine] = pagesSetup([BUN]);
    expect(validatorLine).toContain("['bun', 'none']");
    expect(validatorLine).toContain("pages_setup tokens must be bun or none");
  });

  test("pages command chains nest one parenthesized else per extra module", () => {
    expect(pagesInstallCommand([BUN])).toEqual([
      "  default: \"{{ 'bun install --frozen-lockfile' if 'bun' in pages_setup.split(',') else '' }}\"",
    ]);
    expect(pagesInstallCommand([BUN, UV])).toEqual([
      "  default: \"{{ 'bun install --frozen-lockfile' if 'bun' in pages_setup.split(',') else ('uv sync' if 'uv' in pages_setup.split(',') else '') }}\"",
    ]);
    const deno = manifest("deno", {
      pages: { install: "deno install", build: "deno task build" },
    }) as PagesManifest;
    expect(pagesBuildCommand([BUN, UV, deno])[0]).toBe(
      "  default: \"{{ 'bun run build' if 'bun' in pages_setup.split(',') else ('uv run mkdocs build --site-dir dist' if 'uv' in pages_setup.split(',') else ('deno task build' if 'deno' in pages_setup.split(',') else '')) }}\"",
    );
  });

  test("knownModules renders the biome-shaped set literal", () => {
    expect(knownModules([BUN, RUST])).toEqual([
      "const KNOWN_MODULES = new Set([",
      '  "bun",',
      '  "rust",',
      "]);",
    ]);
  });
});
