import { describe, expect, test } from "bun:test";
import {
  buildMatrix,
  centralTargets,
  type InRepoRow,
  type Target,
} from "../../.github/scripts/fleet/build_settings_matrix";

const OWNER = "Vivswan";
const DIR = "settings/repos";

function file(name: string): { name: string; isDirectory: boolean } {
  return { name, isDirectory: false };
}

function centralTarget(repo: string): Target {
  return {
    repo,
    name: repo.split("/").pop() ?? repo,
    home: "central",
    redact_name: false,
    verify: "",
  };
}

function publicRow(repo: string): InRepoRow {
  return { repo, redact_name: false, hide_details: false, display: repo, verify: "" };
}

describe("centralTargets", () => {
  test("maps <name>.yml files to same-owner central targets", () => {
    const { targets, errors } = centralTargets(OWNER, [file("alpha.yml"), file("beta.yml")], DIR);
    expect(errors).toEqual([]);
    expect(targets).toEqual([centralTarget("Vivswan/alpha"), centralTarget("Vivswan/beta")]);
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
  const central: Target[] = [centralTarget("Vivswan/central")];

  test("merges central and in-repo targets sorted by repo", () => {
    expect(buildMatrix(central, [publicRow("Vivswan/zeta"), publicRow("Vivswan/alpha")])).toEqual([
      { ...centralTarget("Vivswan/alpha"), home: "in-repo" },
      centralTarget("Vivswan/central"),
      { ...centralTarget("Vivswan/zeta"), home: "in-repo" },
    ]);
  });

  test("the central home wins when a slug appears in both lists", () => {
    expect(buildMatrix(central, [publicRow("Vivswan/central")])).toEqual(central);
  });

  test("a duplicated in-repo slug yields one entry", () => {
    expect(buildMatrix([], [publicRow("Vivswan/alpha"), publicRow("Vivswan/alpha")])).toEqual([
      { ...centralTarget("Vivswan/alpha"), home: "in-repo" },
    ]);
  });

  test("a redacted row emits its display, never the slug", () => {
    const row: InRepoRow = {
      repo: "Vivswan/hidden-server",
      redact_name: true,
      hide_details: true,
      display: "h**-s**r",
      verify: "deadbeef",
    };
    const matrix = buildMatrix([], [row]);
    expect(matrix).toEqual([
      {
        repo: "h**-s**r",
        name: "h**-s**r",
        home: "in-repo",
        redact_name: true,
        verify: "deadbeef",
      },
    ]);
    expect(JSON.stringify(matrix)).not.toContain("hidden-server");
  });

  test("central-wins dedupe matches a redacted row on its real slug", () => {
    const row: InRepoRow = {
      repo: "Vivswan/central",
      redact_name: true,
      hide_details: true,
      display: "c**-p**e",
      verify: "deadbeef",
    };
    expect(buildMatrix(central, [row])).toEqual(central);
  });

  test("a self-disclosed private row keeps its committed name", () => {
    const row: InRepoRow = {
      repo: "Vivswan/committed-private",
      redact_name: false,
      hide_details: true,
      display: "Vivswan/committed-private",
      verify: "",
    };
    expect(buildMatrix([], [row])).toEqual([
      {
        repo: "Vivswan/committed-private",
        name: "committed-private",
        home: "in-repo",
        redact_name: false,
        verify: "",
      },
    ]);
  });

  test("no targets is an empty matrix, not an error", () => {
    expect(buildMatrix([], [])).toEqual([]);
  });
});
