#!/usr/bin/env bun
// The sync never targets the operator (its files are the sources), so the operator renders its own .github/settings.yml through the writer's render.
//
// Usage: bun scripts/generate/settings_document.ts [--check] [--root <dir>]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadFilesConfig } from "../../.github/scripts/sync/writer/files_config.ts";
import { readRegistration } from "../../.github/scripts/sync/writer/registration.ts";
import { resolveModules } from "../../.github/scripts/sync/writer/select.ts";
import { parseSettingsDoc } from "../../.github/scripts/sync/writer/settings_document.ts";
import { renderSettings } from "../../.github/scripts/sync/writer/settings_entry.ts";
import { declaredPrivate } from "../../.github/scripts/sync/writer/settings_layers.ts";
import { probe } from "../../.github/scripts/sync/writer/target_files.ts";
import type { FilesConfig, RenderedEntry } from "../../actions/plan/files_config.ts";
import { PLATFORM_OWNER, REGISTRATION_PATH } from "../../actions/shared/platform.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const FILES_CONFIG = "files.yml";
const TREE = "files";

export interface OwnSettings {
  path: string;
  overlayPath: string;
  content: string;
}

function renderedEntry(config: FilesConfig): RenderedEntry {
  const entries = config.files.filter((entry): entry is RenderedEntry => "render" in entry);
  if (entries.length !== 1) {
    throw new Error(
      `${FILES_CONFIG} declares ${entries.length} render: settings entries; this repository renders exactly one`,
    );
  }
  return entries[0];
}

export function renderOwnSettings(root: string): OwnSettings {
  const tree = join(root, TREE);
  const config = loadFilesConfig(join(root, FILES_CONFIG), tree);
  const entry = renderedEntry(config);
  const overlayPath = entry.overlay;
  const overlayAbs = join(root, overlayPath);
  if (!existsSync(overlayAbs)) {
    throw new Error(
      `${overlayPath} is missing - the render reads this repository's overlay from it`,
    );
  }
  const overlay = readFileSync(overlayAbs, "utf-8");
  // The sync falls back to its visibility fact when the overlay is silent.
  // The generator has no GitHub to ask, so the overlay must declare it.
  const visibility = declaredPrivate(parseSettingsDoc(overlay, overlayPath));
  if (visibility === null) {
    throw new Error(
      `${overlayPath} must declare repository.private - the visibility layer is selected by it`,
    );
  }
  const registration = readRegistration(root);
  const { selected, dropped } = resolveModules(config, registration.modules);
  if (dropped.length > 0) {
    throw new Error(
      `${REGISTRATION_PATH} selects module(s) ${FILES_CONFIG} does not know: ${dropped.join(", ")}`,
    );
  }
  const rendered = renderSettings({
    config,
    tree,
    modules: selected,
    private: visibility,
    registration,
    overlay,
    overlayPath,
    owner: PLATFORM_OWNER,
  });
  if ("held" in rendered) throw new Error(`${entry.path} cannot be rendered: ${rendered.held}`);
  return { path: entry.path, overlayPath, content: rendered.content };
}

/** The committed document's text, or null when nothing is there. Probed as the writer probes a managed path, so a
 *  link whose target reads as the render is refused rather than read through (or written through). */
function committedRender(root: string, path: string): string | null {
  const found = probe(root, path);
  if (found.kind === "link") {
    throw new Error(
      `${path} is a symbolic link to ${found.target.toString("utf-8")}; the rendered document is a regular file, as the writer requires at every managed path`,
    );
  }
  return found.kind === "file" ? found.bytes.toString("utf-8") : null;
}

function parseArgs(argv: string[]): { check: boolean; root: string } | { error: string } {
  let check = false;
  let root = REPO_ROOT;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--check") check = true;
    else if (arg === "--root" && argv[index + 1] !== undefined) root = resolve(argv[++index]);
    else
      return {
        error: arg === "--root" ? "--root needs a directory" : `unrecognized argument: ${arg}`,
      };
  }
  return { check, root };
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  if ("error" in args) {
    console.error(`error: ${args.error}`);
    return 2;
  }
  const { check, root } = args;
  let own: OwnSettings;
  let current: string | null;
  try {
    own = renderOwnSettings(root);
    current = committedRender(root, own.path);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (current === own.content) {
    console.log(
      `${own.path} matches the settings layers, the registration, and ${own.overlayPath}`,
    );
    return 0;
  }
  if (check) {
    console.log(
      `${own.path} is stale: it is not the render of the settings layers, the registration, and ${own.overlayPath}; run bun run settings to rewrite it`,
    );
    return 1;
  }
  writeFileSync(join(root, own.path), own.content);
  console.log(`rewrote ${own.path}`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
