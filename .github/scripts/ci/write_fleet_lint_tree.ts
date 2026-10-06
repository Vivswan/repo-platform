#!/usr/bin/env bun
// The sources under files/ carry placeholders and block anchors actionlint cannot read, so ci.yml's actionlint job lints what the
// writer lands instead: one scratch repository per selection (every module, and none).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseFilesConfig } from "../../../actions/plan/files_config.ts";
import { REGISTRATION_PATH } from "../../../actions/shared/platform.ts";
import { must } from "../shared/proc.ts";
import type { SyncReport } from "../sync/writer/report.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const WRITER = join(REPO_ROOT, ".github/scripts/sync/writer/sync.ts");
const PLACEHOLDER_BUILD = "0".repeat(40);

/** The two selections that together land every workflow variant: every
 *  module (the module workflows, the toolchain variants) and none (the
 *  base variants written without a toolchain). */
export function selections(filesText: string): Record<string, string[]> {
  const modules = Object.keys(parseFilesConfig(filesText, "files.yml").modules);
  return { all: modules, none: [] };
}

export function registrationFor(modules: string[]): string {
  return [
    `modules: [${modules.join(", ")}]`,
    "project:",
    "  name: Fleet Lint",
    "  slug: fleet-lint",
    "  description: A scratch repository the fleet workflows are linted in",
    "",
  ].join("\n");
}

export function writtenWorkflows(target: string): string[] {
  const dir = join(target, ".github/workflows");
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => /\.ya?ml$/.test(name))
        .sort()
    : [];
}

/** Optional so the CI step keeps the real host and only the test injects a stub. */
export function writeTargets(dest: string, upstream?: string): Record<string, string[]> {
  const filesText = readFileSync(join(REPO_ROOT, "files.yml"), "utf-8");
  const written: Record<string, string[]> = {};
  for (const [name, modules] of Object.entries(selections(filesText))) {
    const target = join(dest, name);
    mkdirSync(target, { recursive: true });
    // actionlint reads a project's .github/actionlint.yaml (the starter the
    // writer lands) only under a git root.
    must(["git", "init", "-q", target]);
    writeFileSync(join(target, REGISTRATION_PATH), registrationFor(modules));
    const summary = join(dest, `${name}.summary.json`);
    must(
      [
        "bun",
        WRITER,
        "--files",
        join(REPO_ROOT, "files.yml"),
        "--tree",
        join(REPO_ROOT, "files"),
        "--target",
        target,
        "--build",
        PLACEHOLDER_BUILD,
        "--repository",
        "example/fleet-lint",
        "--private",
        "false",
        "--summary",
        summary,
        ...(upstream === undefined ? [] : ["--upstream", upstream]),
      ],
      { cwd: REPO_ROOT },
    );
    writeFileSync(
      join(target, SOURCES_FILE),
      `${JSON.stringify({ tree: name, templates: templatesOf(summary) }, null, 2)}\n`,
    );
    written[name] = writtenWorkflows(target);
    if (written[name].length === 0) {
      throw new Error(`${target}: the writer landed no workflow - the lint would judge nothing`);
    }
  }
  return written;
}

/** The sidecar the shell-complexity check reads (`--sources`) to report a written file's finding against its template. */
export const SOURCES_FILE = ".shell-complexity-sources.json";

/** The mapping the writer states it applied, from its summary: each written path's template under files/ and whether
 *  the template's lines are the written file's. */
export function templatesOf(
  summary: string,
): Record<string, { path: string; lineMapped: boolean }> {
  const report = JSON.parse(readFileSync(summary, "utf-8")) as Pick<SyncReport, "templates">;
  return Object.fromEntries(
    Object.entries(report.templates).map(([written, { source, lineMapped }]) => [
      written,
      { path: join("files", source), lineMapped },
    ]),
  );
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { upstream: { type: "string" } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    console.error("usage: write_fleet_lint_tree.ts <dest> [--upstream <raw-content host>]");
    process.exit(2);
  }
  for (const [name, workflows] of Object.entries(
    writeTargets(resolve(positionals[0]), values.upstream),
  )) {
    console.log(`${name}: ${workflows.length} workflow(s): ${workflows.join(", ")}`);
  }
}
