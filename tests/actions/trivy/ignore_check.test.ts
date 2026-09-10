// ignore_check.ts: the bypass file's contract, judged pure (checkIgnoreFile)
// and through the script the action step runs (exit code, GITHUB_OUTPUT
// row, annotations) against checkouts carrying no file, a valid file, an
// invalid one, and the refused plain format.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkIgnoreFile,
  IGNORE_FILE,
  PLAIN_IGNORE_FILE,
  parseDate,
} from "../../../actions/trivy/ignore_check";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../../actions/trivy/ignore_check.ts");
const TODAY = new Date("2026-09-10T00:00:00Z");

const VALID = [
  "vulnerabilities:",
  "  - id: CVE-2026-65898",
  "    paths:",
  "      - actions/pages-site/bun.lock",
  "    statement: dompurify runs on trusted markdown only",
  "    expired_at: 2026-12-01",
  "misconfigurations:",
  "  - id: DS-0002",
  "    statement: the image is a build tool, never served",
  "    expired_at: 2027-01-15",
  "",
].join("\n");

describe("checkIgnoreFile", () => {
  test("every entry carrying a statement and a future expiry passes", () => {
    expect(checkIgnoreFile(VALID, TODAY)).toEqual({ problems: [], expired: [] });
  });

  test("a missing statement or expiry, a bad date, and unknown keys are each named", () => {
    const text = [
      "vulnerabilities:",
      "  - id: CVE-1",
      "    expired_at: 2026-12-01",
      "  - id: CVE-2",
      "    statement: accepted",
      "  - id: CVE-3",
      "    statement: accepted",
      "    expired_at: 2026-13-01",
      "  - id: CVE-4",
      "    statement: accepted",
      "    expired_at: 2026-12-01",
      "    reason: not a trivy key",
      "  - id: CVE-5",
      "    statement: accepted",
      "    expired_at: 0001-01-01",
      "  - statement: accepted",
      "    expired_at: 2026-12-01",
      "  - plain string",
      "",
    ].join("\n");
    expect(checkIgnoreFile(text, TODAY).problems).toEqual([
      "vulnerabilities[0] (CVE-1): statement must say why the finding is accepted",
      "vulnerabilities[1] (CVE-2): expired_at must be a YYYY-MM-DD date after which the finding blocks again",
      "vulnerabilities[2] (CVE-3): expired_at must be a YYYY-MM-DD date after which the finding blocks again",
      "vulnerabilities[3] (CVE-4): unknown key reason",
      "vulnerabilities[4] (CVE-5): expired_at 0001-01-01 is the zero date, which Trivy never expires; give the bypass a real date",
      "vulnerabilities[5]: id must be a non-empty string",
      "vulnerabilities[6]: must be a mapping with id, statement, and expired_at",
    ]);
  });

  test("the zero date is a problem, not an expiry: Trivy would keep the entry forever", () => {
    const text =
      "secrets:\n  - id: aws-access-key-id\n    statement: fixture\n    expired_at: 0001-01-01\n";
    const result = checkIgnoreFile(text, TODAY);
    expect(result.expired).toEqual([]);
    expect(result.problems).toHaveLength(1);
  });

  test("an expired entry is reported apart from the problems: Trivy already ignores it", () => {
    const text =
      "secrets:\n  - id: aws-access-key-id\n    statement: test fixture\n    expired_at: 2026-09-10\n";
    expect(checkIgnoreFile(text, TODAY)).toEqual({
      problems: [],
      expired: ["secrets[0] (aws-access-key-id)"],
    });
  });

  test("unknown sections, a non-list section, a non-mapping document, and broken YAML fail", () => {
    expect(checkIgnoreFile("cves:\n  - id: CVE-1\n", TODAY).problems).toEqual([
      "cves: not a Trivy ignore section (vulnerabilities, misconfigurations, secrets, licenses)",
    ]);
    expect(checkIgnoreFile("licenses: GPL-3.0\n", TODAY).problems).toEqual([
      "licenses: must be a list of entries",
    ]);
    expect(checkIgnoreFile("- id: CVE-1\n", TODAY).problems).toEqual([
      "must be a mapping with the sections vulnerabilities, misconfigurations, secrets, licenses",
    ]);
    expect(checkIgnoreFile("vulnerabilities: [\n", TODAY).problems[0]).toStartWith(
      "not valid YAML",
    );
  });

  test("parseDate accepts calendar dates only", () => {
    expect(parseDate("2026-02-28")?.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(parseDate(new Date("2026-02-28T00:00:00Z"))?.toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
    for (const bad of ["2026-02-30", "2026-2-8", "tomorrow", 20260228, null, undefined]) {
      expect(parseDate(bad)).toBeNull();
    }
  });
});

describe("the ignore_check step", () => {
  const run = (files: Record<string, string>) => {
    const dir = temp.dir("trivy-ignore-");
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const output = join(dir, "output.txt");
    writeFileSync(output, "");
    const result = boundedSpawnSync([process.execPath, SCRIPT], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_OUTPUT: output },
    });
    return { ...result, output: readFileSync(output, "utf-8") };
  };

  test("no bypass file: green, and the scan gets no ignore file", () => {
    const result = run({});
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("ignorefile=\n");
    expect(result.stdout).toContain("nothing is bypassed");
  });

  test("a valid file: green, and the scan gets it", () => {
    const result = run({ [IGNORE_FILE]: VALID });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(`ignorefile=${IGNORE_FILE}\n`);
    expect(result.stdout).not.toContain("::error");
  });

  test("an entry without a statement: red with a file-anchored annotation, no output row", () => {
    const result = run({
      [IGNORE_FILE]: "vulnerabilities:\n  - id: CVE-1\n    expired_at: 2099-01-01\n",
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("");
    expect(result.stdout).toContain(
      `::error file=${IGNORE_FILE}::${IGNORE_FILE}: vulnerabilities[0] (CVE-1): statement must say why the finding is accepted`,
    );
  });

  test("an expired entry: green with a warning naming it", () => {
    const result = run({
      [IGNORE_FILE]:
        "vulnerabilities:\n  - id: CVE-1\n    statement: accepted\n    expired_at: 2000-01-01\n",
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(`ignorefile=${IGNORE_FILE}\n`);
    expect(result.stdout).toContain(
      "::warning::.trivyignore.yaml: vulnerabilities[0] (CVE-1) has expired",
    );
  });

  test("the plain .trivyignore format is refused even beside a valid YAML file", () => {
    const result = run({ [PLAIN_IGNORE_FILE]: "CVE-1\n", [IGNORE_FILE]: VALID });
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("");
    expect(result.stdout).toContain(`::error file=${PLAIN_IGNORE_FILE}::`);
    expect(result.stdout).toContain("never expire");
  });
});
