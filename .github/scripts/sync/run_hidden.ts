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
import { exitCodeOf, passthrough } from "../shared/proc.ts";

/** The failure manifest failure_issue.ts delivers: one row per recorded
 *  hidden failure. The name, writer, and parser live together here so the
 *  row shape cannot drift between the recorders (this wrapper and
 *  commit_push.ts, which records its lease/push failures itself - it
 *  runs outside this wrapper because its output needs redaction plus
 *  stream-splitting this one-fd capture cannot express) and the
 *  deliverer. */
export const HIDDEN_FAILURES_NAME = "hidden-failures.tsv";

export interface HiddenFailure {
  label: string;
  /** The exit code as recorded (rendered, not computed with). */
  rc: string;
  /** Path of the capture file holding the failure's output. */
  capture: string;
}

/** parseHiddenFailures's TOTAL result: only rows carrying exactly the
 *  three non-empty fields become failures (so HiddenFailure's declared
 *  strings hold); anything else - a torn write, a truncated tail row - is
 *  counted here instead of surfacing as undefined fields, and the
 *  deliverer notes the count in the issue body rather than aborting. */
export interface HiddenFailureManifest {
  failures: HiddenFailure[];
  malformedRows: number;
}

export function appendHiddenFailure(
  runnerTemp: string,
  label: string,
  rc: number,
  capture: string,
): void {
  appendFileSync(join(runnerTemp, HIDDEN_FAILURES_NAME), `${label}\t${rc}\t${capture}\n`);
}

export function parseHiddenFailures(manifest: string): HiddenFailureManifest {
  const failures: HiddenFailure[] = [];
  let malformedRows = 0;
  // Every appendHiddenFailure record is newline-terminated, so the final
  // split segment of a well-formed manifest is "" - the ONLY legal empty
  // segment. A non-empty tail is a torn write even when it happens to
  // carry three fields (its capture path may be cut short), and interior
  // rows fall to the field rule below, which an empty row fails too.
  const rows = manifest.split("\n");
  const tail = rows.pop() ?? "";
  if (tail !== "") malformedRows += 1;
  for (const row of rows) {
    const fields = row.split("\t");
    if (fields.length !== 3 || fields.includes("")) {
      malformedRows += 1;
      continue;
    }
    const [label, rc, capture] = fields;
    failures.push({ label, rc, capture });
  }
  return { failures, malformedRows };
}

/** Capture file name for a label (non-alphanumeric runs squeezed to '-' and
 *  trimmed). Exported so same-run consumers of the captures derive the same
 *  name instead of mirroring the transform. */
export function captureName(label: string): string {
  const slug = label
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "");
  return `hidden-${slug}.log`;
}

function main(): number {
  const [label = "", dashes, ...command] = process.argv.slice(2);
  if (dashes !== "--") {
    console.log("::error::run_hidden.ts: expected '--' after the label");
    return 2;
  }

  if (!hideDetails()) {
    return passthrough(command);
  }

  const runnerTemp = requireEnv("RUNNER_TEMP");
  const capture = join(runnerTemp, captureName(label));
  const log = openSync(capture, "w");
  // Raw Bun.spawnSync, not a proc.ts helper: both output streams go to one
  // FILE descriptor so they interleave in real order, an stdio shape
  // proc.ts does not express. A file fd is not a pipe, so bun 1.4.0's
  // pipe-EOF wait (proc.ts's hang-bound rationale) cannot arise here.
  const proc = Bun.spawnSync(command, { stdio: ["inherit", log, log] });
  const rc = exitCodeOf(proc);
  if (rc === 0) {
    console.log(`${label}: ok (output hidden: private repository)`);
  } else {
    appendHiddenFailure(runnerTemp, label, rc, capture);
    console.log(
      `::error::${label}: failed with exit ${rc} (output hidden: private repository). The captured output is delivered privately - in the sync PR body when one exists, else in the target's failure-report issue (docs/private-repos.md).`,
    );
  }
  return rc;
}

if (import.meta.main) {
  process.exit(main());
}
