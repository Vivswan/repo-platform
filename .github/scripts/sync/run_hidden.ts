#!/usr/bin/env bun
// Safe-output boundary for steps that process a hide-details target's
// checkout. Tools reading that tree (copier, the template validator, the
// retired-file cleanup) print target paths, file content, and parser
// diagnostics that a public log must not carry for a private repository -
// and their failure paths print the most. Wrapping the command captures
// everything and publishes only a generic outcome; the captured output
// stays in RUNNER_TEMP for same-run consumers (never uploaded). A failure
// is also recorded in RUNNER_TEMP/hidden-failures.tsv (label, exit code,
// capture path) so the detail reaches the operator privately: in the sync
// PR body when one exists (open_pr.ts), else delivered to the target's
// failure-report issue (failure_issue.ts, docs/private-repos.md).
//
// Usage: HIDE_DETAILS=true|false run_hidden.ts <label> -- <cmd> [args...]
// Passthrough when HIDE_DETAILS is not "true".

import { appendFileSync, openSync } from "node:fs";
import { join } from "node:path";
import { hideDetails, requireEnv } from "../shared/gha.ts";
import { exitCodeOf } from "../shared/proc.ts";

const [label = "", dashes, ...command] = process.argv.slice(2);
if (dashes !== "--") {
  console.log("::error::run_hidden.ts: expected '--' after the label");
  process.exit(2);
}

if (!hideDetails()) {
  const proc = Bun.spawnSync(command, { stdio: ["inherit", "inherit", "inherit"] });
  process.exit(exitCodeOf(proc));
}

const runnerTemp = requireEnv("RUNNER_TEMP");
const slug = label
  .replace(/[^A-Za-z0-9]+/g, "-")
  .replace(/^-/, "")
  .replace(/-$/, "");
const capture = join(runnerTemp, `hidden-${slug}.log`);
const log = openSync(capture, "w");
const proc = Bun.spawnSync(command, { stdio: ["inherit", log, log] });
const rc = exitCodeOf(proc);
if (rc === 0) {
  console.log(`${label}: ok (output hidden: private repository)`);
} else {
  appendFileSync(join(runnerTemp, "hidden-failures.tsv"), `${label}\t${rc}\t${capture}\n`);
  console.log(
    `::error::${label}: failed with exit ${rc} (output hidden: private repository). The captured output is delivered privately - in the sync PR body when one exists, else in the target's failure-report issue (docs/private-repos.md).`,
  );
}
process.exit(rc);
