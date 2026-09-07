// The validator's tables: the fixture mirror pinned equal to the generated
// ownership tables, and the entry's CHECKS roster covering every checks/ module.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASE_OWNERSHIP,
  type BaseOwnedFile,
  MODULE_OWNERSHIP,
} from "../../../../../actions/validate-template-report/validator/ownership.ts";
import {
  MIRROR_BASE,
  MIRROR_MODULES,
  type MirrorEntry,
  VALIDATOR,
  VALIDATOR_DIR,
} from "./fixtures";

describe("the ownership mirror", () => {
  test("the fixture mirror equals the generated ownership tables", () => {
    // The mirror stamps every fixture's manifest, so a table change it
    // misses would turn into a confusing cross-check error in unrelated
    // tests; pin the whole twin instead.
    const asMirror = (entry: BaseOwnedFile): MirrorEntry => ({
      path: entry.path,
      kind: entry.kind,
      ...(entry.kind === "region" ? { begin: entry.begin, end: entry.end } : {}),
      ...(entry.when?.publicOnly ? { publicOnly: true } : {}),
      ...(entry.when?.withoutModule !== undefined
        ? { withoutModule: entry.when.withoutModule }
        : {}),
    });
    const sortByPath = (entries: MirrorEntry[]) =>
      [...entries].sort((a, b) => a.path.localeCompare(b.path));
    expect(sortByPath(MIRROR_BASE)).toEqual(sortByPath(BASE_OWNERSHIP.map(asMirror)));
    expect(MIRROR_MODULES).toEqual(
      Object.fromEntries(
        Object.entries(MODULE_OWNERSHIP).map(([module, entries]) => [
          module,
          (entries ?? []).map(asMirror),
        ]),
      ),
    );
  });
});

describe("the check roster", () => {
  test("every checks/ module is imported by the entry and runs from CHECKS", () => {
    // A new check module typechecks on its own, so only the entry's roster
    // decides whether it ever runs: a module left out of CHECKS would be a
    // silently inert check.
    const entry = readFileSync(VALIDATOR, "utf-8");
    const roster = /const CHECKS[\s\S]*?= \[\n([\s\S]*?)\n\];/.exec(entry)?.[1] ?? "";
    const modules = readdirSync(join(VALIDATOR_DIR, "checks"))
      .filter((name) => name.endsWith(".ts"))
      .sort();
    const listed = modules.map((file) => {
      const imported = new RegExp(
        `import \\{ (check\\w+) \\} from "\\./checks/${file.replace(".", "\\.")}";`,
      ).exec(entry)?.[1];
      return {
        file,
        imported: imported ?? null,
        run: imported !== undefined && roster.includes(`${imported},`),
      };
    });
    expect(listed).toEqual(
      modules.map((file) => ({ file, imported: expect.stringMatching(/^check\w+$/), run: true })),
    );
  });
});
