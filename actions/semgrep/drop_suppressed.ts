#!/usr/bin/env bun
// semgrep keeps a nosemgrep-marked finding in its SARIF as a suppressed result, and code scanning reads no
// `suppressions` property, so an unfiltered upload shows the bypassed finding as an OPEN alert. A scan that wrote no
// SARIF leaves nothing to filter; the upload step then fails on the missing file.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requireEnv } from "../shared/action_runtime.ts";

interface SarifResult {
  suppressions?: unknown[];
}

interface Sarif {
  runs?: { results?: SarifResult[] }[];
}

/** Every run's results minus the suppressed ones; everything else in the document stays as written. */
export function dropSuppressed(sarif: Sarif): Sarif {
  for (const run of sarif.runs ?? []) {
    if (run.results === undefined) continue;
    run.results = run.results.filter((result) => (result.suppressions ?? []).length === 0);
  }
  return sarif;
}

if (import.meta.main) {
  const path = join(requireEnv("RUNNER_TEMP"), "semgrep.sarif");
  if (existsSync(path)) {
    // Written beside and renamed over, so a failed write leaves the original for the upload.
    const filtered = `${path}.upload`;
    writeFileSync(
      filtered,
      JSON.stringify(dropSuppressed(JSON.parse(readFileSync(path, "utf8")) as Sarif)),
    );
    renameSync(filtered, path);
  }
}
