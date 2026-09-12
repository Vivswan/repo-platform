import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  actionManifestPaths,
  actionSetsUpBun,
  BUN_SETUP_ACTION,
  bunPinnedActionDirs,
  strayActionPinFiles,
} from "../../../scripts/lib/action_steps.ts";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();

const SHARED = `runs:\n  steps:\n    - id: action-bun\n      uses: Vivswan/repo-platform/${BUN_SETUP_ACTION}@stable\n      with:\n        pin: \${{ github.action_path }}/.bun-version\n`;
const OWN_SETUP =
  "runs:\n  steps:\n    - uses: oven-sh/setup-bun@v2\n      with:\n        bun-version-file: ${{ inputs.pin }}\n";

describe("action steps", () => {
  test.each([
    {
      shape: "a quoted uses",
      text: 'runs:\n  steps:\n    - uses: "oven-sh/setup-bun@v2"\n',
      setsUp: true,
    },
    {
      shape: "a mixed-case uses",
      text: "runs:\n  steps:\n    - uses: OVEN-SH/Setup-Bun@v2\n",
      setsUp: true,
    },
    {
      shape: "a uses-shaped line inside a run body",
      text: "runs:\n  steps:\n    - shell: bash\n      run: |\n        echo demo\n        - uses: oven-sh/setup-bun@v2\n",
      setsUp: false,
    },
    {
      shape: "a commented example",
      text: "runs:\n  steps:\n    # - uses: oven-sh/setup-bun@v2\n",
      setsUp: false,
    },
    { shape: "no steps", text: "name: x\n", setsUp: false },
  ])("actionSetsUpBun judges the parsed steps: $shape", ({ text, setsUp }) => {
    expect(actionSetsUpBun(text)).toBe(setsUp);
  });

  test("actionManifestPaths lists every action.yml and action.yaml, nested ones included, sorted; symlinks, other files, and unpublished directories are not manifests", () => {
    const dir = temp.dir("action-manifests-");
    mkdirSync(join(dir, "pages-site", "check-links"), { recursive: true });
    writeFileSync(join(dir, "pages-site", "action.yml"), SHARED);
    writeFileSync(join(dir, "pages-site", "check-links", "action.yml"), SHARED);
    writeFileSync(join(dir, "pages-site", "site.ts"), "export {};\n");
    mkdirSync(join(dir, "spelled-long"));
    writeFileSync(join(dir, "spelled-long", "action.yaml"), SHARED);
    mkdirSync(join(dir, "pages-site", "node_modules", "dep"), { recursive: true });
    writeFileSync(join(dir, "pages-site", "node_modules", "dep", "action.yml"), SHARED);
    mkdirSync(join(dir, "shared"));
    symlinkSync(join(dir, "pages-site", "action.yml"), join(dir, "shared", "action.yml"));
    mkdirSync(join(dir, "x"));
    writeFileSync(join(dir, "x", "not-action.yml"), SHARED);
    symlinkSync(join(dir, "spelled-long"), join(dir, "linked-dir"));
    expect(actionManifestPaths(dir)).toEqual([
      "actions/pages-site/action.yml",
      "actions/pages-site/check-links/action.yml",
      "actions/spelled-long/action.yaml",
    ]);
  });

  test("bunPinnedActionDirs lists the bun-setup callers (nested too); commented uses, own setup-bun, and manifest-free dirs never count", () => {
    const dir = temp.dir("action-pins-");
    mkdirSync(join(dir, "typo"));
    writeFileSync(join(dir, "typo", "action.yml"), SHARED);
    // A nested action (the pages-site/check-links shape).
    mkdirSync(join(dir, "pages", "links"), { recursive: true });
    writeFileSync(join(dir, "pages", "action.yml"), SHARED);
    writeFileSync(join(dir, "pages", "links", "action.yml"), SHARED);
    mkdirSync(join(dir, "gate"));
    writeFileSync(
      join(dir, "gate", "action.yml"),
      "runs:\n  steps:\n    # - uses: Vivswan/repo-platform/actions/bun-setup@stable\n    - run: echo ok\n",
    );
    // The shared setup action sets up bun for its callers' pins, and an
    // inline setup-bun of its own is the same shape: neither is pinned.
    mkdirSync(join(dir, "bun-setup"));
    writeFileSync(join(dir, "bun-setup", "action.yml"), OWN_SETUP);
    mkdirSync(join(dir, "inline"));
    writeFileSync(join(dir, "inline", "action.yml"), OWN_SETUP);
    mkdirSync(join(dir, "typo", "node_modules", "dep"), { recursive: true });
    writeFileSync(join(dir, "typo", "node_modules", "dep", "action.yml"), SHARED);
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "run.ts"), "export {};\n");
    expect(bunPinnedActionDirs(dir)).toEqual([
      "actions/pages",
      "actions/pages/links",
      "actions/typo",
    ]);
  });

  test("strayActionPinFiles flags every .bun-version whose directory calls no bun-setup", () => {
    const dir = temp.dir("action-strays-");
    mkdirSync(join(dir, "typo"));
    writeFileSync(join(dir, "typo", "action.yml"), SHARED);
    writeFileSync(join(dir, "typo", ".bun-version"), "1.4.0\n");
    // The bun-setup step retired but the dotfile left behind.
    mkdirSync(join(dir, "gate"));
    writeFileSync(join(dir, "gate", "action.yml"), "runs:\n  steps:\n    - run: echo ok\n");
    writeFileSync(join(dir, "gate", ".bun-version"), "1.4.0\n");
    // The shared action reads its callers' pins: a dotfile there is stray.
    mkdirSync(join(dir, "bun-setup"));
    writeFileSync(join(dir, "bun-setup", "action.yml"), OWN_SETUP);
    writeFileSync(join(dir, "bun-setup", ".bun-version"), "1.4.0\n");
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", ".bun-version"), "1.4.0\n");
    expect(strayActionPinFiles(dir)).toEqual([
      "actions/bun-setup/.bun-version",
      "actions/gate/.bun-version",
      "actions/scripts/.bun-version",
    ]);
  });
});
