// Entry selection: the four when clauses and the module resolution that
// drops unknown names instead of failing.

import { describe, expect, test } from "bun:test";
import { parseFilesConfig } from "../../../.github/scripts/sync/writer/files_config.ts";
import {
  applies,
  resolveModules,
  selectEntries,
} from "../../../.github/scripts/sync/writer/select.ts";

const CONFIG = parseFilesConfig(`
placeholders: []
modules: { bun: {}, pages: {}, docs-site: {}, fuzzer: {} }
files:
  - { path: ci.yml, class: managed }
  - { path: docs.yml, class: managed, when: { modules: [docs-site], without: [pages] }, source: files/docs-site/a.yml }
  - { path: docs.yml, class: managed, when: { modules: [docs-site, pages] }, source: files/docs-site/b.yml }
  - { path: fuzz.yml, class: starter, when: { modules: [fuzzer] } }
  - { path: private.yml, class: managed, when: { private: true } }
  - { path: toolchain.yml, class: managed, when: { any: [bun, fuzzer] } }
`);

describe("applies", () => {
  test.each([
    [{ modules: ["a", "b"] }, ["a", "b"], true],
    [{ modules: ["a", "b"] }, ["a"], false],
    [{ any: ["a", "b"] }, ["b"], true],
    [{ any: ["a", "b"] }, [], false],
    [{ without: ["a"] }, ["b"], true],
    [{ without: ["a"] }, ["a", "b"], false],
    [{ private: true }, [], false],
    [null, [], true],
  ])("%j with %j -> %p", (when, modules, expected) => {
    expect(applies(when, { modules, private: false })).toBe(expected);
  });
});

describe("selectEntries", () => {
  test("picks one docs.yml variant per selection and honours visibility", () => {
    const paths = (modules: string[], isPrivate: boolean) =>
      selectEntries(CONFIG, { modules, private: isPrivate }).map((e) => `${e.path}<${e.source}`);
    expect(paths(["docs-site"], false)).toEqual(["ci.yml<base/ci.yml", "docs.yml<docs-site/a.yml"]);
    expect(paths(["docs-site", "pages", "bun"], true)).toEqual([
      "ci.yml<base/ci.yml",
      "docs.yml<docs-site/b.yml",
      "private.yml<base/private.yml",
      "toolchain.yml<base/toolchain.yml",
    ]);
  });
});

describe("resolveModules", () => {
  test("keeps known names in files.yml order and reports the rest", () => {
    expect(resolveModules(CONFIG, ["fuzzer", "uv", "bun", "release-please"])).toEqual({
      selected: ["bun", "fuzzer"],
      dropped: ["uv", "release-please"],
    });
  });
});
