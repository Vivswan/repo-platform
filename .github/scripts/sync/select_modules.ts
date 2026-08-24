#!/usr/bin/env bun
// Selects the target's modules for the update (modules.ts's pure selection
// filtered against the template ref) into $RUNNER_TEMP/modules.json - a
// file, not a step output, because the module list is a target-derived
// fact and step outputs ride into later steps' env-group prints.
// Hide-details targets get counts, not names; selection failure detail
// (unknown module names, YAML parse text - all target-derived) is withheld
// for them and printed as ::error:: commands otherwise. Retired module
// names land in $RUNNER_TEMP/retired-modules.txt for open_pr.ts.
//
// Env: TARGET_DISPLAY, HIDE_DETAILS, RUNNER_TEMP.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { env, error, hideDetails, notice, requireEnv } from "../shared/gha.ts";
import { filterModules, readModuleChoices, readModules } from "./modules.ts";

const runnerTemp = requireEnv("RUNNER_TEMP");
const display = env("TARGET_DISPLAY");
const repoFile = "target/.repo-platform.yml";
const copierFile = join(runnerTemp, "copier-new.yml");

/** Selection failures carry target-derived detail (file content quotes,
 * module names); a hide-details target gets the count-free generic line. */
function failSelection(messages: string[]): never {
  if (hideDetails()) {
    error(
      `module selection for ${display} failed (detail hidden: private repository). Reproduce the sync locally - see docs/private-repos.md.`,
    );
  } else {
    for (const message of messages) error(message);
  }
  process.exit(1);
}

function parseYamlFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    failSelection([`${path}: cannot read the file`]);
  }
  try {
    // logLevel error: the parser's default level prints warned-on source
    // lines to stderr, which would bypass failSelection's hide-details
    // handling for target-controlled file content.
    return parse(text, { logLevel: "error" });
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    failSelection([`${path}: YAML parse error: ${detail}`]);
  }
}

const { modules, errors: moduleErrors } = readModules(parseYamlFile(repoFile), repoFile);
if (modules === null) {
  failSelection(moduleErrors);
}
const { choices, errors: choiceErrors } = readModuleChoices(parseYamlFile(copierFile), copierFile);
if (choices === null) {
  failSelection(choiceErrors);
}
const { kept, dropped, errors } = filterModules(modules, choices);
if (errors.length > 0) {
  failSelection(errors.map((message) => `${repoFile}: ${message}`));
}

writeFileSync(join(runnerTemp, "modules.json"), JSON.stringify(kept));
// open_pr.ts reads the retired names from this file for the PR body.
writeFileSync(join(runnerTemp, "retired-modules.txt"), dropped.map((name) => `${name}\n`).join(""));

if (hideDetails()) {
  console.log(`selected modules: ${kept.length} (names hidden: private repository)`);
  if (dropped.length > 0) {
    notice(
      `${display}: ${dropped.length} retired module(s) dropped from the selection; their files leave the render with this update.`,
    );
  }
} else {
  console.log(`selected modules: ${JSON.stringify(kept)}`);
  for (const name of dropped) {
    notice(
      `${display}: retired module '${name}' dropped from the selection; its files leave the render with this update.`,
    );
  }
}
