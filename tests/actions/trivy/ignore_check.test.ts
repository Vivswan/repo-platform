// Trivy ignores an entry key it does not know (external): a `reason:` typed for `statement:` passes Trivy, so the
// check must name it. The zero date is Go's zero time, which Trivy's expiry prune skips forever, and an entry expiring
// today is already expired (Trivy's `<=`); V8 rolls `2026-02-30` over to March 2 silently, which the round trip refuses.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkIgnoreFile,
  IGNORE_FILE,
  PLAIN_IGNORE_FILE,
} from "../../../actions/trivy/ignore_check";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../../actions/trivy/ignore_check.ts");
const TODAY = new Date("2026-09-10T00:00:00Z");

// The CLI rows run on the real clock, so a fixed future date would expire under the suite one day.
const FUTURE = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
const VALID = [
  "vulnerabilities:",
  "  - id: CVE-2026-65898",
  "    paths:",
  "      - actions/pages-site/bun.lock",
  "    statement: dompurify runs on trusted markdown only",
  `    expired_at: ${FUTURE}`,
  "misconfigurations:",
  "  - id: DS-0002",
  "    statement: the image is a build tool, never served",
  `    expired_at: ${FUTURE}`,
  "",
].join("\n");

const EXPIRY_PROBLEM = "expired_at must be a YYYY-MM-DD date after which the finding blocks again";
const entry = (id: string, expiredAt: string) =>
  `vulnerabilities:\n  - id: ${id}\n    statement: accepted\n    expired_at: ${expiredAt}\n`;

describe("checkIgnoreFile", () => {
  test.each<{
    reason: string;
    text: string;
    problems: (string | ReturnType<typeof expect.stringContaining>)[];
    expired?: string[];
  }>([
    { reason: "every entry carrying a statement and a future expiry", text: VALID, problems: [] },
    {
      reason:
        "a missing statement or expiry, a bad date, an unknown key, the zero date, no id, a non-mapping entry",
      text: [
        "vulnerabilities:",
        "  - id: CVE-1",
        `    expired_at: ${FUTURE}`,
        "  - id: CVE-2",
        "    statement: accepted",
        "  - id: CVE-3",
        "    statement: accepted",
        "    expired_at: 2026-13-01",
        "  - id: CVE-4",
        "    statement: accepted",
        `    expired_at: ${FUTURE}`,
        "    reason: not a trivy key",
        "  - id: CVE-5",
        "    statement: accepted",
        "    expired_at: 0001-01-01",
        "  - statement: accepted",
        `    expired_at: ${FUTURE}`,
        "  - plain string",
        "",
      ].join("\n"),
      problems: [
        "vulnerabilities[0] (CVE-1): statement must say why the finding is accepted",
        `vulnerabilities[1] (CVE-2): ${EXPIRY_PROBLEM}`,
        `vulnerabilities[2] (CVE-3): ${EXPIRY_PROBLEM}`,
        "vulnerabilities[3] (CVE-4): unknown key reason",
        "vulnerabilities[4] (CVE-5): expired_at 0001-01-01 is the zero date, which Trivy never expires; give the bypass a real date",
        "vulnerabilities[5]: id must be a non-empty string",
        "vulnerabilities[6]: must be a mapping with id, statement, and expired_at",
      ],
    },
    {
      reason: "an entry expiring today is expired, apart from the problems",
      text: entry("CVE-1", "2026-09-10"),
      problems: [],
      expired: ["vulnerabilities[0] (CVE-1)"],
    },
    {
      reason: "a calendar date that does not exist",
      text: entry("CVE-1", "2026-02-30"),
      problems: [`vulnerabilities[0] (CVE-1): ${EXPIRY_PROBLEM}`],
    },
    {
      reason: "a date with unpadded fields",
      text: entry("CVE-1", "2026-2-8"),
      problems: [`vulnerabilities[0] (CVE-1): ${EXPIRY_PROBLEM}`],
    },
    {
      reason: "a date spelled as a word",
      text: entry("CVE-1", "tomorrow"),
      problems: [`vulnerabilities[0] (CVE-1): ${EXPIRY_PROBLEM}`],
    },
    {
      reason: "a date written as a number",
      text: entry("CVE-1", "20260228"),
      problems: [`vulnerabilities[0] (CVE-1): ${EXPIRY_PROBLEM}`],
    },
    {
      reason: "an unknown section",
      text: "cves:\n  - id: CVE-1\n",
      problems: [
        "cves: not a Trivy ignore section (vulnerabilities, misconfigurations, secrets, licenses)",
      ],
    },
    {
      reason: "a section that is not a list",
      text: "licenses: GPL-3.0\n",
      problems: ["licenses: must be a list of entries"],
    },
    {
      reason: "a non-mapping document",
      text: "- id: CVE-1\n",
      problems: [
        "must be a mapping with the sections vulnerabilities, misconfigurations, secrets, licenses",
      ],
    },
    {
      reason: "broken YAML",
      text: "vulnerabilities: [\n",
      problems: [expect.stringContaining("not valid YAML")],
    },
  ])("$reason", ({ text, problems, expired }) => {
    expect(checkIgnoreFile(text, TODAY)).toEqual({ problems, expired: expired ?? [] });
  });
});

// The executed entry point: an empty `ignorefile=` output is what leaves the scan's `trivyignores` input unset, and
// Trivy honors the plain .trivyignore file, whose entries never expire, so its presence is refused even beside a valid
// YAML file.
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
    return {
      exitCode: result.exitCode,
      output: readFileSync(output, "utf-8"),
      stdout: result.stdout,
    };
  };

  test.each<{
    reason: string;
    files: Record<string, string>;
    exitCode: number;
    output: string;
    stdout: string[];
  }>([
    {
      reason: "no bypass file: green, and the scan gets no ignore file",
      files: {},
      exitCode: 0,
      output: "ignorefile=\n",
      stdout: [`no ${IGNORE_FILE}: nothing is bypassed`],
    },
    {
      reason: "a valid file: green, and the scan gets it",
      files: { [IGNORE_FILE]: VALID },
      exitCode: 0,
      output: `ignorefile=${IGNORE_FILE}\n`,
      stdout: [`${IGNORE_FILE}: every entry carries a statement and an expiry`],
    },
    {
      reason: "an entry without a statement: red with a file-anchored annotation, no output row",
      files: { [IGNORE_FILE]: "vulnerabilities:\n  - id: CVE-1\n    expired_at: 2099-01-01\n" },
      exitCode: 1,
      output: "",
      stdout: [
        `::error file=${IGNORE_FILE}::${IGNORE_FILE}: vulnerabilities[0] (CVE-1): statement must say why the finding is accepted`,
      ],
    },
    {
      reason: "an expired entry: green with a warning naming it, and no error",
      files: { [IGNORE_FILE]: entry("CVE-1", "2000-01-01") },
      exitCode: 0,
      output: `ignorefile=${IGNORE_FILE}\n`,
      stdout: [
        `::warning::${IGNORE_FILE}: vulnerabilities[0] (CVE-1) has expired; Trivy no longer ignores it - fix the finding or delete the entry`,
        `${IGNORE_FILE}: every entry carries a statement and an expiry`,
      ],
    },
    {
      reason: "the plain .trivyignore format is refused even beside a valid YAML file",
      files: { [PLAIN_IGNORE_FILE]: "CVE-1\n", [IGNORE_FILE]: VALID },
      exitCode: 1,
      output: "",
      stdout: [
        `::error file=${PLAIN_IGNORE_FILE}::${PLAIN_IGNORE_FILE} is not honored: its entries never expire. Move each one into ${IGNORE_FILE} with a statement and an expired_at date.`,
      ],
    },
  ])("$reason", ({ files, exitCode, output, stdout }) => {
    const result = run(files);
    expect([result.exitCode, result.output, result.stdout.trimEnd().split("\n")]).toEqual([
      exitCode,
      output,
      stdout,
    ]);
  });
});
