import { describe, expect, test } from "bun:test";
import { buildMatrix, centralTargets, type Target } from "./build_settings_matrix";

const OWNER = "Vivswan";
const DIR = "settings/repos";

function file(name: string): { name: string; isDirectory: boolean } {
  return { name, isDirectory: false };
}

describe("centralTargets", () => {
  test("maps <name>.yml files to same-owner central targets", () => {
    const { targets, errors } = centralTargets(OWNER, [file("alpha.yml"), file("beta.yml")], DIR);
    expect(errors).toEqual([]);
    expect(targets).toEqual([
      { repo: "Vivswan/alpha", name: "alpha", home: "central" },
      { repo: "Vivswan/beta", name: "beta", home: "central" },
    ]);
  });

  test("ignores non-YAML entries like a README", () => {
    const { targets, errors } = centralTargets(OWNER, [file("README.md")], DIR);
    expect(errors).toEqual([]);
    expect(targets).toEqual([]);
  });

  test("a .yaml suffix is an error, never a silent drop from the matrix", () => {
    const { errors } = centralTargets(OWNER, [file("alpha.yaml")], DIR);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("settings/repos/alpha.yaml");
    expect(errors[0]).toContain(".yml suffix");
  });

  test("an owner subdirectory is an error, never a silent drop from the matrix", () => {
    const { errors } = centralTargets(OWNER, [{ name: "other-org", isDirectory: true }], DIR);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("settings/repos/other-org");
    expect(errors[0]).toContain("owner subdirectories");
  });
});

describe("buildMatrix", () => {
  const central: Target[] = [{ repo: "Vivswan/central", name: "central", home: "central" }];

  test("merges central and in-repo targets sorted by repo", () => {
    expect(buildMatrix(central, ["Vivswan/zeta", "Vivswan/alpha"])).toEqual([
      { repo: "Vivswan/alpha", name: "alpha", home: "in-repo" },
      { repo: "Vivswan/central", name: "central", home: "central" },
      { repo: "Vivswan/zeta", name: "zeta", home: "in-repo" },
    ]);
  });

  test("the central home wins when a slug appears in both lists", () => {
    expect(buildMatrix(central, ["Vivswan/central"])).toEqual(central);
  });

  test("a duplicated in-repo slug yields one entry", () => {
    expect(buildMatrix([], ["Vivswan/alpha", "Vivswan/alpha"])).toEqual([
      { repo: "Vivswan/alpha", name: "alpha", home: "in-repo" },
    ]);
  });

  test("no targets is an empty matrix, not an error", () => {
    expect(buildMatrix([], [])).toEqual([]);
  });
});
