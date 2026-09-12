#!/usr/bin/env bun
// Each composite action calling the shared bun-setup step gets its own .bun-version so an action never rides the CALLER's bun resolution.
//
// Usage: bun scripts/generate/toolchain_pins.ts [--check]

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type FilesConfig, parseFilesConfig } from "../../actions/plan/files_config.ts";
import { bunPinnedActionDirs, strayActionPinFiles } from "../lib/action_steps.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const FILES_CONFIG = "files.yml";

export interface ToolchainPin {
  module: string;
  file: string;
  version: string;
}

export function toolchainPins(filesText: string, label = FILES_CONFIG): ToolchainPin[] {
  return pinsOf(parseFilesConfig(filesText, label));
}

function pinsOf(config: FilesConfig): ToolchainPin[] {
  return Object.entries(config.modules).flatMap(([module, data]) =>
    data.pin === undefined ? [] : [{ module, ...data.pin }],
  );
}

/** A pin renamed in files.yml but not in its files entry would leave the writer copying the old dotfile forever. */
export function undeliveredPins(config: FilesConfig): string[] {
  return pinsOf(config).flatMap((pin) => {
    const source = `${pin.module}/${pin.file}`;
    const delivered = config.files.some(
      (entry) =>
        entry.path === pin.file &&
        entry.class !== "link" &&
        !("render" in entry) &&
        entry.source === source,
    );
    return delivered
      ? []
      : [
          `files.yml modules.${pin.module}.pin names ${pin.file} but no files entry delivers ` +
            `files/${source} - add the entry (or drop the pin)`,
        ];
  });
}

/** A renamed or dropped pin leaves the old dotfile behind, and a files entry still listing it keeps delivering the stale version;
 *  matching by content rather than name catches a renamed dotfile too. */
export function strayPinFiles(pins: ToolchainPin[], filesDir: string): string[] {
  const expected = new Set(pins.map((pin) => `${pin.module}/${pin.file}`));
  const strays: string[] = [];
  for (const module of readdirSync(filesDir).sort()) {
    const dir = join(filesDir, module);
    if (module === "base" || !statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (!statSync(path).isFile() || expected.has(`${module}/${name}`)) continue;
      if (/^\d+\.\d+\.\d+\n?$/.test(readFileSync(path, "utf-8")))
        strays.push(`files/${module}/${name}`);
    }
  }
  return strays;
}

/** The version dotfile a pin lands as: exactly the version plus a trailing
 *  newline (what the setup actions' version-file readers expect). */
export function pinFileContent(pin: ToolchainPin): string {
  return `${pin.version}\n`;
}

export function bunToolchainPin(pins: ToolchainPin[]): ToolchainPin {
  const bun = pins.find((pin) => pin.module === "bun");
  if (bun === undefined) {
    throw new Error(
      "files.yml modules.bun declares no pin - the .bun-version dotfiles have no source",
    );
  }
  return bun;
}

export function pinOutputs(pins: ToolchainPin[], actionsDir: string): [string, string][] {
  const bun = bunToolchainPin(pins);
  return [
    ...pins.map((pin): [string, string] => [
      `files/${pin.module}/${pin.file}`,
      pinFileContent(pin),
    ]),
    ...bunPinnedActionDirs(actionsDir).map((dir): [string, string] => [
      `${dir}/.bun-version`,
      pinFileContent(bun),
    ]),
    [".bun-version", pinFileContent(bun)],
  ];
}

export function stalePinOutputs(pins: ToolchainPin[], root: string): [string, string][] {
  return pinOutputs(pins, join(root, "actions")).filter(([rel, content]) => {
    const path = join(root, rel);
    return !existsSync(path) || readFileSync(path, "utf-8") !== content;
  });
}

function main(argv: string[]): number {
  const check = argv.includes("--check");
  const unknown = argv.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    console.error(`error: unrecognized argument(s): ${unknown.join(" ")}`);
    return 2;
  }
  const config = parseFilesConfig(
    readFileSync(join(REPO_ROOT, FILES_CONFIG), "utf-8"),
    FILES_CONFIG,
  );
  const pins = pinsOf(config);
  const problems = [
    ...undeliveredPins(config),
    ...strayPinFiles(pins, join(REPO_ROOT, "files")).map(
      (rel) =>
        `stray version dotfile ${rel} that no files.yml pin names - delete it (or restore the pin)`,
    ),
    ...strayActionPinFiles(join(REPO_ROOT, "actions")).map(
      (rel) =>
        `stray action .bun-version dotfile ${rel} whose action.yml calls no bun-setup step - the ` +
        "stale pin keeps shipping on the build branch; delete the file (or restore the action's bun-setup step)",
    ),
  ];
  if (problems.length > 0) {
    for (const problem of problems) console.error(`error: ${problem}`);
    return 1;
  }
  const stale = stalePinOutputs(pins, REPO_ROOT);
  if (stale.length === 0) {
    console.log("toolchain pin dotfiles match files.yml");
    return 0;
  }
  if (check) {
    for (const [rel] of stale) {
      console.log(
        `${rel} is stale: its content does not match the pin in files.yml; run bun run pins to rewrite it`,
      );
    }
    return 1;
  }
  for (const [rel, content] of stale) {
    writeFileSync(join(REPO_ROOT, rel), content);
    console.log(`rewrote ${rel}`);
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
