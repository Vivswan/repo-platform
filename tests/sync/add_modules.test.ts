import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withModules } from "../../.github/scripts/sync/add_modules.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../.github/scripts/sync/add_modules.ts");

describe("withModules", () => {
  const UNKNOWN_LAYOUT =
    ".repo-platform.yml: the modules list could not be extended in place (a layout this step does not know); add the names on a branch and sync that";

  // The whole file after the edit: the yaml library's serializer would re-indent an unindented list and fold a long
  // description, so the edit is a splice and every other byte (comments, quoting, a missing final newline) must
  // survive. A name already selected stays where it is; a registration the grammar refuses is refused here in the
  // grammar's words, and a layout the splice cannot extend is refused rather than guessed at.
  test.each<{ reason: string; text: string; expected: ReturnType<typeof withModules> }>([
    {
      reason: "an indented block list keeps its comments and the rest of the file",
      text: "# head\nmodules:\n  - bun # keep\nexcept:\n  - a\nproject:\n  name: x\n",
      expected: {
        text: "# head\nmodules:\n  - bun # keep\n  - site\n  - nightly\nexcept:\n  - a\nproject:\n  name: x\n",
        added: ["site", "nightly"],
      },
    },
    {
      reason: "an unindented block list without a final newline keeps both",
      text: "modules:\n- bun\nproject: {name: x}",
      expected: {
        text: "modules:\n- bun\n- site\n- nightly\nproject: {name: x}",
        added: ["site", "nightly"],
      },
    },
    {
      reason: "a quoted entry sets no quoting on the added ones",
      text: 'modules:\n  - "bun"\n',
      expected: {
        text: 'modules:\n  - "bun"\n  - site\n  - nightly\n',
        added: ["site", "nightly"],
      },
    },
    {
      reason: "a flow list grows before its bracket, its comment kept",
      text: "modules: [bun] # c\nproject: {name: x}\n",
      expected: {
        text: "modules: [bun, site, nightly] # c\nproject: {name: x}\n",
        added: ["site", "nightly"],
      },
    },
    {
      reason: "an empty flow list takes the names alone",
      text: "modules: []\n",
      expected: { text: "modules: [site, nightly]\n", added: ["site", "nightly"] },
    },
    {
      reason: "a name already selected is left where it is",
      text: "modules:\n  - site\n  - bun\n",
      expected: { text: "modules:\n  - site\n  - bun\n  - nightly\n", added: ["nightly"] },
    },
    {
      reason: "every name already selected is no edit",
      text: "modules: [nightly, site]\n",
      expected: { text: "modules: [nightly, site]\n", added: [] },
    },
    {
      reason: "no modules list is the grammar's refusal",
      text: "project: {name: x}\n",
      expected: {
        error:
          ".repo-platform.yml: no module selection found - add a top-level `modules: [...]` list (the sync never assumes an empty selection, which would strip every module from the repo)",
      },
    },
    {
      reason: "a scalar in the list's place is the grammar's refusal",
      text: "modules: bun\n",
      expected: { error: ".repo-platform.yml: modules must be a list of module names" },
    },
    {
      reason: "a file that does not parse is refused with the parser's first line",
      text: "modules: [\n",
      expected: {
        error:
          ".repo-platform.yml: YAML parse error: Flow sequence in block collection must be sufficiently indented and end with a ] at line 2, column 1:",
      },
    },
    {
      reason: "a flow list with a trailing comma reads back wrong and is refused, not written",
      text: "modules: [bun, ]\n",
      expected: { error: UNKNOWN_LAYOUT },
    },
  ])("$reason", ({ text, expected }) => {
    expect(withModules(text, ["site", "nightly"])).toEqual(expected);
  });
});

describe("add_modules.ts", () => {
  function run(addModules: string, registration: string | null, linked: string | null) {
    const root = temp.dir("add-modules-");
    const target = join(root, "target");
    mkdirSync(target);
    const path = join(target, ".repo-platform.yml");
    if (linked !== null) {
      writeFileSync(join(root, "outside.yml"), linked);
      symlinkSync(join(root, "outside.yml"), path);
    } else if (registration !== null) writeFileSync(path, registration);
    const result = boundedSpawnSync(["bun", SCRIPT], {
      cwd: root,
      env: { ...process.env, ADD_MODULES: addModules, TARGET_DIR: target },
    });
    return { ...result, registration: existsSync(path) ? readFileSync(path, "utf-8") : null };
  }

  // The step runs on every row, so a run with the plan's empty output must touch nothing and say nothing; the stdout is
  // the log the failure issue carries, so a refusal is one ::error:: line there, and the file stays as it was. A
  // registration that is a link is refused as the writer refuses it, before the edit could land outside the target.
  test.each<{
    reason: string;
    addModules: string;
    registration: string | null;
    /** The registration as a link to a file outside the target, with this content. */
    linked?: string;
    expected: { exitCode: number; stdout: string; registration: string | null };
  }>([
    {
      reason: "an empty list writes nothing",
      addModules: "",
      registration: "modules: [bun]\n",
      expected: { exitCode: 0, stdout: "", registration: "modules: [bun]\n" },
    },
    {
      reason: "the plan's names land in the target's file",
      addModules: "site,nightly",
      registration: "modules:\n  - bun\nproject: {name: x}\n",
      expected: {
        exitCode: 0,
        stdout: "add_modules: added site, nightly to .repo-platform.yml\n",
        registration: "modules:\n  - bun\n  - site\n  - nightly\nproject: {name: x}\n",
      },
    },
    {
      reason: "names already selected leave the file untouched",
      addModules: "bun",
      registration: "modules: [bun]\n",
      expected: {
        exitCode: 0,
        stdout:
          "add_modules: every dispatched module is already selected; the registration is unchanged\n",
        registration: "modules: [bun]\n",
      },
    },
    {
      reason: "a registration that is a link is refused, and the file it points at is untouched",
      addModules: "bun",
      registration: null,
      linked: "modules: [site]\n",
      expected: {
        exitCode: 1,
        stdout:
          "::error::.repo-platform.yml: not a regular file in the target repository; the writer will not replace it\n",
        registration: "modules: [site]\n",
      },
    },
    {
      reason: "a target without a registration is refused",
      addModules: "bun",
      registration: null,
      expected: {
        exitCode: 1,
        stdout: "::error::.repo-platform.yml: missing from the target repository\n",
        registration: null,
      },
    },
    {
      reason: "a registration the grammar refuses is refused in its words",
      addModules: "bun",
      registration: "modules: bun\n",
      expected: {
        exitCode: 1,
        stdout: "::error::.repo-platform.yml: modules must be a list of module names\n",
        registration: "modules: bun\n",
      },
    },
  ])("$reason", ({ addModules, registration, linked = null, expected }) => {
    const result = run(addModules, registration, linked);
    expect({
      exitCode: result.exitCode,
      stdout: result.stdout,
      registration: result.registration,
    }).toEqual(expected);
    expect(result.stderr).toBe("");
  });
});
