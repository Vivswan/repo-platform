// Unit tests for the toolchain pin writer: the pins read off files.yml,
// the dotfiles derived from them (module pins, action-local .bun-version
// files, the root pin), and the live check against the committed tree.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { capture } from "../../../.github/scripts/shared/proc.ts";
import { parseFilesConfig } from "../../../actions/plan/files_config.ts";
import {
  bunToolchainPin,
  pinFileContent,
  pinOutputs,
  stalePinOutputs,
  strayPinFiles,
  toolchainPins,
  undeliveredPins,
} from "../../../scripts/generate/toolchain_pins";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = resolve(import.meta.dir, "../../..");

const FILES_YML = [
  "placeholders: [project_name]",
  "modules:",
  "  bun:",
  "    description: bun",
  "    pin: {file: .bun-version, version: 1.4.0}",
  "  node:",
  "    description: node",
  "    pin: {file: .node-version, version: 24.19.0}",
  "  uv:",
  "    description: uv",
  "files:",
  "  - {path: .bun-version, class: managed, when: {modules: [bun]}}",
  "  - {path: .node-version, class: managed, when: {modules: [node]}}",
  "",
].join("\n");

describe("toolchainPins", () => {
  test("reads the pinned modules in files.yml order, unpinned ones skipped", () => {
    expect(toolchainPins(FILES_YML)).toEqual([
      { module: "bun", file: ".bun-version", version: "1.4.0" },
      { module: "node", file: ".node-version", version: "24.19.0" },
    ]);
  });

  test("a pin off the grammar is refused by files.yml's own schema", () => {
    expect(() => toolchainPins(FILES_YML.replace("1.4.0", "1.4"))).toThrow();
  });
});

describe("pinOutputs", () => {
  test("every dotfile is the version plus a newline: module pins, each bun-setup action, the root", () => {
    const pins = toolchainPins(FILES_YML);
    expect(pinFileContent(pins[0])).toBe("1.4.0\n");
    const outputs = pinOutputs(pins, join(REPO_ROOT, "actions"));
    expect(outputs.slice(0, 2)).toEqual([
      ["files/bun/.bun-version", "1.4.0\n"],
      ["files/node/.node-version", "24.19.0\n"],
    ]);
    expect(outputs.at(-1)).toEqual([".bun-version", "1.4.0\n"]);
    const actionPins = outputs.slice(2, -1);
    expect(actionPins.length).toBeGreaterThan(0);
    expect(actionPins).toContainEqual(["actions/plan/.bun-version", "1.4.0\n"]);
    expect(actionPins.every(([, content]) => content === "1.4.0\n")).toBe(true);
  });

  test("a files.yml without a bun pin has no source for the .bun-version files", () => {
    expect(() => bunToolchainPin(toolchainPins(FILES_YML).slice(1))).toThrow(
      "modules.bun declares no pin",
    );
  });
});

describe("undeliveredPins", () => {
  test("every pin with a files entry at its file from the module's copy passes; a renamed pin is named", () => {
    expect(undeliveredPins(parseFilesConfig(FILES_YML, "t"))).toEqual([]);
    const renamed = FILES_YML.replace(
      "pin: {file: .node-version, version: 24.19.0}",
      "pin: {file: .node-version-new, version: 24.19.0}",
    );
    expect(undeliveredPins(parseFilesConfig(renamed, "t"))).toEqual([
      "files.yml modules.node.pin names .node-version-new but no files entry delivers files/node/.node-version-new - add the entry (or drop the pin)",
    ]);
    // An entry at the path sourced from ANOTHER module's copy does not deliver this pin.
    const other = FILES_YML.replace(
      "  - {path: .node-version, class: managed, when: {modules: [node]}}",
      "  - {path: .node-version, class: managed, when: {modules: [node]}, source: files/bun/.node-version}",
    );
    expect(undeliveredPins(parseFilesConfig(other, "t"))).toHaveLength(1);
  });
});

describe("strayPinFiles", () => {
  test("a one-version-line dotfile no pin names is a stray whatever its name; base and other files are never strays", () => {
    const filesDir = temp.dir("toolchain-pins-files-");
    for (const rel of [
      "bun/.bun-version",
      "node/.node-version",
      "uv/.python-version",
      "deno/.dvmrc",
      "deno/.bun-version",
      "base/.node-version",
    ]) {
      mkdirSync(join(filesDir, rel.split("/")[0]), { recursive: true });
      writeFileSync(join(filesDir, rel), "1.0.0\n");
    }
    writeFileSync(join(filesDir, "uv/.gitignore.block.Python"), "x\n");
    writeFileSync(join(filesDir, "uv/settings.yml"), "labels: []\n");
    expect(strayPinFiles(toolchainPins(FILES_YML), filesDir)).toEqual([
      "files/deno/.bun-version",
      "files/deno/.dvmrc",
      "files/uv/.python-version",
    ]);
  });
});

describe("stalePinOutputs", () => {
  test("names a dotfile whose content drifted or is missing, with the content the pin writes", () => {
    const root = temp.dir("toolchain-pins-root-");
    mkdirSync(join(root, "actions"), { recursive: true });
    mkdirSync(join(root, "files/bun"), { recursive: true });
    mkdirSync(join(root, "files/node"), { recursive: true });
    writeFileSync(join(root, "files/bun/.bun-version"), "1.4.0\n");
    writeFileSync(join(root, "files/node/.node-version"), "24.18.0\n");
    writeFileSync(join(root, ".bun-version"), "1.4.0\n");
    expect(stalePinOutputs(toolchainPins(FILES_YML), root)).toEqual([
      ["files/node/.node-version", "24.19.0\n"],
    ]);
    writeFileSync(join(root, "files/node/.node-version"), "24.19.0\n");
    expect(stalePinOutputs(toolchainPins(FILES_YML), root)).toEqual([]);
  });
});

describe("the live check", () => {
  test("the committed dotfiles match files.yml", () => {
    const pins = toolchainPins(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"));
    for (const [rel, content] of pinOutputs(pins, join(REPO_ROOT, "actions"))) {
      expect([rel, readFileSync(join(REPO_ROOT, rel), "utf-8")]).toEqual([rel, content]);
    }
    const run = capture(["bun", "scripts/generate/toolchain_pins.ts", "--check"], {
      cwd: REPO_ROOT,
    });
    expect([run.exitCode, run.stdout.trim()]).toEqual([
      0,
      "toolchain pin dotfiles match files.yml",
    ]);
  });
});
