#!/usr/bin/env bun
// The copier-render oracle for the generated dogfood copies: the
// dogfood-oracle smoke row renders /tmp/smoke with this repository's own
// answers (.repo-platform-answers.yml), and this script byte-compares each
// generated pair's rendered file against the committed copy - proving the
// TS renderer behind `bun run dogfood` (scripts/render_dogfood.ts +
// scripts/jinja_subset.ts) agrees with what real copier produces from the
// same templates and answers.
//
// No normalization before comparing: the committed copies carry the
// render's remote-form `@build` pins verbatim (this repository consumes
// the same green-gated delivery branch the fleet does), so the oracle is
// a raw byte comparison.
//
// The rendered .github/.copier-answers.yml is checked against the answers
// file
// first, so a dogfood-oracle matrix row that drifts from
// .repo-platform-answers.yml fails here instead of comparing the wrong
// render.
//
// Usage: bun .github/scripts/ci/verify_dogfood_oracle.ts [render-root]
//        (render-root defaults to /tmp/smoke)

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ANSWERS_FILE, PAIRS, parseAnswers } from "../../../scripts/render_dogfood.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.length > 1) fail(`expected at most one argument (render root), got: ${args.join(" ")}`);
  const renderRoot = args[0] ?? "/tmp/smoke";

  const answers = parseAnswers(readFileSync(join(REPO_ROOT, ANSWERS_FILE), "utf-8"), ANSWERS_FILE);

  // The render must have used this repository's answers, or every
  // comparison below compares against the wrong project.
  const recordedPath = join(renderRoot, ".github/.copier-answers.yml");
  if (!existsSync(recordedPath)) {
    fail(`${recordedPath} not found - run the dogfood-oracle smoke render first`);
  }
  const recorded: unknown = parseYaml(readFileSync(recordedPath, "utf-8"));
  if (!isMapping(recorded)) {
    fail(`${recordedPath}: expected a YAML mapping of recorded answers`);
  }
  const wrongAnswers: string[] = [];
  const expectRecorded = (key: string, expected: string | boolean) => {
    const got = recorded[key];
    if (got !== expected) {
      wrongAnswers.push(`${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    }
  };
  expectRecorded("project_name", answers.project_name);
  expectRecorded("github_username", answers.github_username);
  expectRecorded("private", answers.private);
  // Asked (and recorded) only while the skills module is selected.
  if (answers.skills_dir !== undefined) expectRecorded("skills_dir", answers.skills_dir);
  // Asked (and recorded) only while the docs-site module is selected.
  if (answers.docs_site_label !== undefined) {
    expectRecorded("docs_site_label", answers.docs_site_label);
  }
  const recordedModules = Array.isArray(recorded.modules) ? recorded.modules.map(String) : [];
  if (
    recordedModules.length !== answers.modules.size ||
    !recordedModules.every((m) => answers.modules.has(m))
  ) {
    wrongAnswers.push(
      `modules: expected [${[...answers.modules].join(", ")}], got [${recordedModules.join(", ")}]`,
    );
  }
  if (wrongAnswers.length > 0) {
    for (const problem of wrongAnswers) console.error(`${recordedPath}: ${problem}`);
    fail(
      `the render's recorded answers do not match ${ANSWERS_FILE} - ` +
        "fix ci.yml's dogfood-oracle matrix row",
    );
  }

  // No localization: the dogfooded copies carry copier's remote-form
  // @build pins verbatim (this repo consumes the same green-gated
  // delivery branch the fleet does), so the oracle byte-compares raw
  // render output. The retired @main -> ./ rewrite would only mask the
  // regression the fleet-refs-ride-build ssot rule now reds.

  let failures = 0;
  let compared = 0;
  const skipped: string[] = [];
  for (const pair of PAIRS) {
    const renderedPath = join(renderRoot, pair.repo);
    const committedPath = join(REPO_ROOT, pair.repo);
    const renderedExists = existsSync(renderedPath);
    const committedExists = existsSync(committedPath);
    if (!renderedExists || !committedExists) {
      if (renderedExists !== committedExists) {
        console.error(
          `${pair.repo}: ${renderedExists ? "copier rendered it but no committed copy exists" : "committed copy exists but copier did not render it"} ` +
            "- the answers, the matrix row, and the template's filename gate disagree",
        );
        failures++;
      } else {
        // Both sides agree the pair's filename gate is false; nothing to
        // byte-compare, but say so instead of counting it as compared.
        skipped.push(pair.repo);
      }
      continue;
    }
    compared++;
    const rendered = readFileSync(renderedPath, "utf-8");
    const committed = readFileSync(committedPath, "utf-8");
    if (rendered === committed) continue;
    const renderedLines = rendered.split("\n");
    const committedLines = committed.split("\n");
    const max = Math.max(renderedLines.length, committedLines.length);
    for (let i = 0; i < max; i++) {
      if (renderedLines[i] !== committedLines[i]) {
        console.error(
          `${pair.repo}: line ${i + 1} differs from the copier render of ${pair.tpl}\n` +
            `  copier:    ${JSON.stringify(renderedLines[i] ?? "<end of file>")}\n` +
            `  committed: ${JSON.stringify(committedLines[i] ?? "<end of file>")}`,
        );
        break;
      }
    }
    failures++;
  }
  if (failures > 0) {
    console.error(
      `dogfood oracle: ${failures} of ${PAIRS.length} pairs disagree with the copier render`,
    );
    return 1;
  }
  if (skipped.length > 0) {
    console.log(`skipped (absent on both sides, gate false): ${skipped.join(", ")}`);
  }
  console.log(
    `dogfood oracle: ${compared} of ${PAIRS.length} pairs compared, all match the copier render byte-for-byte`,
  );
  return 0;
}

process.exit(main());
