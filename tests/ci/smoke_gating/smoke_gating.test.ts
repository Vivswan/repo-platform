// Module and visibility gating on a rendered smoke project: the right
// files exist for the selected modules and the right fragments appear
// inside shared files. The expectation tables (expectations.ts) always
// get their own unit tests; the render-backed suite runs only with
// SMOKE_DIR set to a smoke_generate.ts render (ci.yml's smoke-generate
// matrix passes MODULES, PRIVATE, and EXTRA_DATA for the row that produced
// it) and skips loudly otherwise. The code under test is
// reached only through the rendered files and two settings-assembly
// subprocesses.

import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";
import { runChecks } from "./checks.ts";
import {
  ANY_TOOLCHAIN,
  ENABLE_CODEQL,
  EXPECTATIONS,
  GATED_MODULES,
  MANIFEST_CLASSES,
  MERGED_SETTINGS,
  MERGED_SETTINGS_EXPECTATIONS,
  MODULES,
  type Row,
  type Selection,
  selectionFromEnv,
} from "./expectations.ts";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
const EXPECTATIONS_FILE = "tests/ci/smoke_gating/expectations.ts";

const EVERYTHING =
  "[bun, node, deno, uv, rust, pages, docs-site, release-please, issue-templates, skills, pr-title, fuzzer, nightly, custom-license]";

describe("the expectation tables", () => {
  test("every module is conditioned by at least one row", () => {
    expect([...GATED_MODULES].sort()).toEqual([...MODULES].sort());
  });

  // Rows are [modules, private, extra data, the derived selection facts]
  // for the matrix rows whose derivations differ.
  test.each([
    {
      modules: EVERYTHING,
      isPrivate: "false",
      extra: "",
      derived: {
        modules: [...MODULES] as string[],
        skillsDir: "skills",
        enableCodeql: true,
        anyToolchain: true,
      },
    },
    {
      // Copier normalizes the multiselect to its choices order.
      modules: "[pages, bun]",
      isPrivate: "true",
      extra: "",
      derived: {
        modules: ["bun", "pages"] as string[],
        skillsDir: "skills",
        enableCodeql: false,
        anyToolchain: true,
      },
    },
    {
      modules: "[node, skills]",
      isPrivate: "false",
      extra: "-d skills_dir=lib/skills",
      derived: {
        modules: ["node", "skills"] as string[],
        skillsDir: "lib/skills",
        enableCodeql: true,
        anyToolchain: true,
      },
    },
    {
      // copier keeps the last -d occurrence of a repeated answer.
      modules: "[node, skills]",
      isPrivate: "false",
      extra: "-d skills_dir=lib/skills -d skills_dir=agent-skills",
      derived: {
        modules: ["node", "skills"] as string[],
        skillsDir: "agent-skills",
        enableCodeql: true,
        anyToolchain: true,
      },
    },
    {
      // rust is outside the CodeQL toolchains but inside any-toolchain.
      modules: "[rust, fuzzer]",
      isPrivate: "false",
      extra: "",
      derived: {
        modules: ["rust", "fuzzer"] as string[],
        skillsDir: "skills",
        enableCodeql: false,
        anyToolchain: true,
      },
    },
    {
      modules: "[]",
      isPrivate: "false",
      extra: "",
      derived: {
        modules: [] as string[],
        skillsDir: "skills",
        enableCodeql: false,
        anyToolchain: false,
      },
    },
  ])("derives the selection facts for modules=$modules private=$isPrivate", (row) => {
    const selection = selectionFromEnv(row.modules, row.isPrivate, row.extra);
    expect({
      modules: MODULES.filter((m) => selection.modules.has(m)) as string[],
      skillsDir: selection.skillsDir,
      enableCodeql: ENABLE_CODEQL.holds(selection),
      anyToolchain: ANY_TOOLCHAIN.holds(selection),
    }).toEqual(row.derived);
  });

  test("a matrix row naming an unknown module or a non-boolean PRIVATE is refused", () => {
    expect(() => selectionFromEnv("[bun, agents]", "false", "")).toThrow(/unknown module 'agents'/);
    expect(() => selectionFromEnv("[bun]", "yes", "")).toThrow(/PRIVATE must be/);
    expect(() => selectionFromEnv("bun", "false", "")).toThrow(/must be a YAML list/);
  });

  test("every row yields checks for the everything and the empty selection", () => {
    for (const selection of [EVERYTHING, "[]"].map((m) => selectionFromEnv(m, "false", ""))) {
      for (const row of [...EXPECTATIONS, ...MERGED_SETTINGS_EXPECTATIONS]) {
        expect(row.checks(selection).length).toBeGreaterThan(0);
      }
    }
  });
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `SMOKE_DIR is set, so ${name} (the matrix row that produced the render) is required`,
    );
  }
  return value;
}

function applicable(rows: Row[], selection: Selection): Row[] {
  return rows.filter((row) => row.when.holds(selection));
}

const smokeDir = process.env.SMOKE_DIR;
if (smokeDir === undefined || smokeDir === "") {
  test.skip("rendered gating needs SMOKE_DIR (a smoke_generate.ts render) plus its row's MODULES and PRIVATE", () => {});
} else {
  const modules = requireEnv("MODULES");
  const isPrivate = requireEnv("PRIVATE");
  const selection = selectionFromEnv(modules, isPrivate, process.env.EXTRA_DATA ?? "");
  const hint = `for modules=${modules} private=${isPrivate}; fix the gate in templates/ (or this expectation in ${EXPECTATIONS_FILE})`;
  const temp = tempDirs();

  describe(`rendered gating for modules=${modules} private=${isPrivate}`, () => {
    for (const row of applicable(EXPECTATIONS, selection)) {
      test(`${row.name} [${row.when.label}]`, () => {
        runChecks(smokeDir, row.checks(selection), hint);
      });
    }

    // Single-call CI re-homed the gate jobs into the operator's fleet-ci,
    // so the render no longer shows their bodies; the thin-caller shapes
    // are pinned against this repository's own file. validate-template's
    // INTEGRITY leg blocks (the fail-last step re-raises the action's
    // deferred verdict) while FRESHNESS only informs; yamllint's pin is
    // called exactly once, by the base-checks job.
    test("fleet-ci.yml carries the validate-template and yamllint pins at @build", () => {
      runChecks(
        REPO_ROOT,
        [
          {
            kind: "text",
            path: ".github/workflows/fleet-ci.yml",
            has: [
              "actions/validate-template-report@build",
              "steps.template.outputs.integrity != 'success'",
            ],
          },
          {
            kind: "count",
            path: ".github/workflows/fleet-ci.yml",
            substring: "repo-platform/actions/yamllint@build",
            expected: 1,
          },
        ],
        "(the operator's fleet-ci.yml; fix fleet-ci.yml or this expectation)",
      );
    });

    // The assembly CLI runs as a black box against the rendered repo's own
    // recorded facts; the merged document (the rendered layers plus the
    // smoke repo's settings.yml plus the fleet override) is what the apply
    // receives, and only it shows the whole contract.
    describe("assembled settings", () => {
      let assembled = "";
      beforeAll(
        () => {
          const work = temp.dir("smoke-gating-");
          const env = { ...process.env, GITHUB_OUTPUT: join(work, "step-output.txt") };
          const managed = join(work, "managed-settings.yml");
          const commands = [
            [
              "bun",
              join(REPO_ROOT, ".github/scripts/fleet/render_managed_settings.ts"),
              "--repo",
              "smoke/test",
              "--target-dir",
              smokeDir,
              "--out",
              managed,
            ],
            [
              "bun",
              join(REPO_ROOT, ".github/scripts/fleet/merge_settings_layers.ts"),
              "--managed",
              managed,
              "--repo-file",
              join(smokeDir, ".github/settings.yml"),
              "--out",
              join(work, MERGED_SETTINGS),
            ],
          ];
          for (const argv of commands) {
            const result = boundedSpawnSync(argv, { cwd: REPO_ROOT, env, timeoutMs: 120_000 });
            if (result.exitCode !== 0) {
              throw new Error(
                `${argv.join(" ")} exited ${result.exitCode}\n${result.stdout}${result.stderr}`,
              );
            }
          }
          assembled = work;
        },
        { timeout: 120_000 },
      );
      for (const row of applicable(MERGED_SETTINGS_EXPECTATIONS, selection)) {
        test(`${row.name} [${row.when.label}]`, () => {
          runChecks(assembled, row.checks(selection), hint);
        });
      }
    });

    // The ownership manifest is rendered for every row and stamped by the
    // template's post-render task; classes and hashes are read here
    // independently of the stamping and validation code under test.
    const manifestPath = ".github/repo-platform-manifest.json";
    type Entry = Record<string, unknown>;
    const manifest = (): Record<string, Entry | undefined> => {
      const doc = JSON.parse(readFileSync(join(smokeDir, manifestPath), "utf8")) as {
        files: Record<string, Entry | undefined>;
      };
      return doc.files;
    };

    test("the manifest records each path's ownership class", () => {
      const files = manifest();
      const mismatches: string[] = [];
      for (const row of MANIFEST_CLASSES.filter((r) => r.when.holds(selection))) {
        const entry = files[row.path];
        const got = entry === undefined ? "absent" : String(entry.class);
        if (got !== row.class) mismatches.push(`${row.path}: expected ${row.class}, got ${got}`);
      }
      // The registration starter is generated once and read, never
      // rewritten, so a hash there would re-arm the drift check against the
      // very edits the file exists for.
      if (files[".repo-platform.yml"] !== undefined && "hash" in files[".repo-platform.yml"]) {
        mismatches.push(".repo-platform.yml: a starter entry must carry no hash key");
      }
      expect(mismatches, `manifest classes ${hint}`).toEqual([]);
    });

    test("the stamp hashes ci.yml whole and SECURITY.md's managed region, never itself, and records the render's commit", () => {
      const files = manifest();
      const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

      const ci = files[".github/workflows/ci.yml"];
      expect(ci?.hash, "ci.yml hash").toBe(
        sha256(readFileSync(join(smokeDir, ".github/workflows/ci.yml"))),
      );

      // The region runs from the start of the first BEGIN line through the
      // first END line after it, newline included; lines split on \n alone
      // and a marker line matches by trimmed equality. The file is read as
      // latin1 so each byte is one character and trim() strips \xa0 like
      // the stamper's trim on latin1 bytes.
      const security = files[".github/SECURITY.md"];
      if (security === undefined) throw new Error(".github/SECURITY.md has no manifest entry");
      const data = readFileSync(join(smokeDir, ".github/SECURITY.md")).toString("latin1");
      const lines = data.split(/(?<=\n)/);
      const beginAt = lines.findIndex((line) => line.trim() === String(security.begin));
      const endAt = lines.findIndex(
        (line, index) => index > beginAt && line.trim() === String(security.end),
      );
      expect(beginAt, "BEGIN marker line").toBeGreaterThanOrEqual(0);
      expect(endAt, "END marker line after BEGIN").toBeGreaterThan(beginAt);
      const region = Buffer.from(lines.slice(beginAt, endAt + 1).join(""), "latin1");
      expect(security.hash, "SECURITY.md managed-region hash").toBe(sha256(region));

      const self = files[manifestPath];
      expect(self?.hash, "the manifest's own hash (a self-hash would be circular)").toBeNull();

      // The stamp hook rewrites _commit from copier's vcs_ref_hash on
      // every render: the full sha, never git's abbreviation or a tag. An
      // all-digit sha is written quoted so YAML reads it as a string.
      const answers = parseYaml(
        readFileSync(join(smokeDir, ".github/.copier-answers.yml"), "utf8"),
      ) as {
        _commit?: unknown;
      };
      expect(typeof answers._commit, "_commit must be a YAML string (quoted when all digits)").toBe(
        "string",
      );
      expect(answers._commit).toMatch(/^[0-9a-f]{40}$/);
      expect(self?.commit, "the manifest's provenance commit").toBe(answers._commit);
    });
  });
}
