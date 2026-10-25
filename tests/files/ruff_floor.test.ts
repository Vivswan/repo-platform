// Two facts that would drift silently: the uv module's wiring lands ruff.toml, and every `uvx ruff` site spells one
// pinned version. The test reads ruff.toml alone, so every upstream file is a stub and never the network.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFilesConfig } from "../../actions/plan/files_config";
import { isManaged } from "../../actions/shared/managed_header";
import { syncedCheckout } from "../shared/synced_checkout";
import { tempDirs } from "../shared/temp_dir";
import { spawnStubUpstream } from "../shared/upstream_server";

const temp = tempDirs();
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const FLOOR = "ruff.toml";
const RUFF_SITES = [
  ".github/workflows/fleet.yml",
  ...readdirSync(join(REPO_ROOT, "files/uv"), { recursive: true, encoding: "utf-8" })
    .map((rel) => join("files/uv", rel))
    .filter((rel) => statSync(join(REPO_ROOT, rel)).isFile()),
];

const config = parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"));
const upstream = await spawnStubUpstream(config, temp.dir("ruff-floor-upstream-"));
afterAll(() => upstream.stop());

const synced = (label: string, modules: string[]) =>
  syncedCheckout({ target: temp.dir(`ruff-floor-${label}-`), upstream: upstream.host, modules });

describe("the managed ruff.toml", () => {
  test("lands for the uv module alone, rendered as a managed file that still parses as TOML", () => {
    expect(existsSync(join(synced("none", []), FLOOR))).toBe(false);
    const text = readFileSync(join(synced("uv", ["uv"]), FLOOR), "utf-8");
    expect(text).not.toContain("{{");
    expect(isManaged(text)).toBe(true);
    expect(() => Bun.TOML.parse(text)).not.toThrow();
  });
});

describe("the ruff pin", () => {
  test("every `uvx ruff` line in fleet.yml and the uv starters names the same release; none floats", () => {
    const spelled = RUFF_SITES.flatMap((rel) =>
      [...readFileSync(join(REPO_ROOT, rel), "utf-8").matchAll(/\buvx ruff(\S*)/g)].map(
        (match) => `${rel}: uvx ruff${match[1]}`,
      ),
    );
    const versions = new Set(spelled.map((line) => line.slice(line.indexOf("uvx ruff"))));
    expect({
      gate: spelled.filter((line) => line.startsWith(".github/")).length,
      versions: [...versions],
    }).toEqual({
      gate: 1,
      versions: [expect.stringMatching(/^uvx ruff@\d+\.\d+\.\d+$/)],
    });
  });
});
