// The executed entry point of the scan's sink: a finding is a `::warning` on its target and exit 0, so the step is
// green and the annotation carries what Trivy's table used to (the id, the package and its fix, the advisory link),
// ordered worst first per target; a clean target annotates nothing, and a clean scan says so.

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../../actions/trivy/annotate.ts");

const RESULTS = {
  SchemaVersion: 2,
  Results: [
    { Target: "bun.lock", Class: "lang-pkgs", Type: "bun" },
    {
      Target: "actions/pages-site/bun.lock",
      Class: "lang-pkgs",
      Type: "bun",
      Vulnerabilities: [
        {
          VulnerabilityID: "CVE-2026-2",
          PkgName: "esbuild",
          InstalledVersion: "0.21.5",
          FixedVersion: "0.25.0",
          Severity: "HIGH",
          Title: "esbuild enables any website to send any requests to the development server",
          PrimaryURL: "https://avd.aquasec.com/nvd/cve-2026-2",
        },
        {
          VulnerabilityID: "CVE-2026-1",
          PkgName: "left-pad",
          InstalledVersion: "1.0.0",
          FixedVersion: "1.0.1",
          Severity: "CRITICAL",
          Title: "left-pad: padding overflow",
          PrimaryURL: "https://avd.aquasec.com/nvd/cve-2026-1",
        },
        { VulnerabilityID: "CVE-2026-3", PkgName: "odd", InstalledVersion: "1", Severity: "WEIRD" },
      ],
    },
    {
      Target: "Dockerfile",
      Class: "config",
      Type: "dockerfile",
      Misconfigurations: [
        {
          ID: "DS-0002",
          Title: "Image user should not be 'root'",
          Severity: "HIGH",
          Resolution: "Add 'USER <non root user name>' line to the Dockerfile",
          PrimaryURL: "https://avd.aquasec.com/misconfig/ds-0002",
          CauseMetadata: { StartLine: 1 },
        },
      ],
    },
  ],
};

describe("the annotate step", () => {
  const run = (results: unknown) => {
    const dir = temp.dir("trivy-annotate-");
    const resultsPath = join(dir, "trivy.json");
    writeFileSync(resultsPath, JSON.stringify(results));
    return boundedSpawnSync([process.execPath, SCRIPT], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, RESULTS: resultsPath },
    });
  };

  test.each<{ reason: string; results: unknown; lines: string[] }>([
    {
      reason:
        "one warning per finding on its target, worst first, an unknown severity last; then the count; exit 0",
      results: RESULTS,
      lines: [
        "::warning title=Trivy,file=actions/pages-site/bun.lock::CRITICAL CVE-2026-1 left-pad 1.0.0 (fixed in 1.0.1): left-pad: padding overflow https://avd.aquasec.com/nvd/cve-2026-1",
        "::warning title=Trivy,file=actions/pages-site/bun.lock::HIGH CVE-2026-2 esbuild 0.21.5 (fixed in 0.25.0): esbuild enables any website to send any requests to the development server https://avd.aquasec.com/nvd/cve-2026-2",
        "::warning title=Trivy,file=actions/pages-site/bun.lock::UNKNOWN CVE-2026-3 odd 1 (no fix released):",
        "::warning title=Trivy,file=Dockerfile::HIGH DS-0002 line 1: Image user should not be 'root'. Add 'USER <non root user name>' line to the Dockerfile https://avd.aquasec.com/misconfig/ds-0002",
        "trivy found 4 finding(s) in 2 target(s), advisory: 1 CRITICAL, 2 HIGH, 1 UNKNOWN",
      ],
    },
    {
      reason: "a clean scan annotates nothing",
      results: { SchemaVersion: 2, Results: [{ Target: "bun.lock" }] },
      lines: ["trivy found nothing"],
    },
    {
      reason: "a scan with no results at all is a clean scan",
      results: { SchemaVersion: 2 },
      lines: ["trivy found nothing"],
    },
  ])("$reason", ({ results, lines }) => {
    const result = run(results);
    expect([result.exitCode, result.stderr, result.stdout.trimEnd().split("\n")]).toEqual([
      0,
      "",
      lines,
    ]);
  });
});
