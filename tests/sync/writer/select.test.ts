import { describe, expect, test } from "bun:test";
import { parseFilesConfig, selectEntries } from "../../../actions/plan/files_config.ts";

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

describe("selectEntries", () => {
  test("picks one docs.yml variant per selection and honours visibility", () => {
    const paths = (modules: string[], isPrivate: boolean) =>
      selectEntries(CONFIG, { modules, private: isPrivate }).map(
        (e) => `${e.path}<${e.class === "link" ? e.target : "render" in e ? e.render : e.source}`,
      );
    expect(paths(["docs-site"], false)).toEqual(["ci.yml<base/ci.yml", "docs.yml<docs-site/a.yml"]);
    expect(paths(["docs-site", "pages", "bun"], true)).toEqual([
      "ci.yml<base/ci.yml",
      "docs.yml<docs-site/b.yml",
      "private.yml<base/private.yml",
      "toolchain.yml<base/toolchain.yml",
    ]);
  });

  test("an excepted path is dropped whatever its clause; a path no entry has changes nothing", () => {
    const paths = (except: string[]) =>
      selectEntries(CONFIG, { modules: ["bun"], private: false, except }).map((e) => e.path);
    expect(paths([])).toEqual(["ci.yml", "toolchain.yml"]);
    expect(paths(["ci.yml"])).toEqual(["toolchain.yml"]);
    expect(paths(["ci.yml", "toolchain.yml", "nothing.yml"])).toEqual([]);
  });
});
