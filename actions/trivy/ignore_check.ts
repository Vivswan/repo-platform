// Every bypass entry carries an expiry and a reason, so Trivy drops it when the date passes and the finding blocks again on its own.
// The plain .trivyignore format has no expiry field, so its presence fails the check; so does the zero date, which Trivy keeps forever.

import { existsSync, readFileSync } from "node:fs";
import { error, setFailed, setOutput, warning } from "@actions/core";
import { messageOf } from "../shared/action_runtime.ts";
import { isMapping } from "../shared/values.ts";

/** Trivy's YAML ignore file: the one format with an expiry per entry. */
export const IGNORE_FILE = ".trivyignore.yaml";

/** Trivy's plain ignore file: no expiry, so its presence fails the check. */
export const PLAIN_IGNORE_FILE = ".trivyignore";

/** The sections Trivy reads from the YAML file. */
export const SECTIONS = ["vulnerabilities", "misconfigurations", "secrets", "licenses"] as const;

/** The keys Trivy reads on an entry. */
export const ENTRY_KEYS = ["id", "paths", "purls", "statement", "expired_at"] as const;

/** Go's zero time: Trivy's expiry prune skips it, so such an entry never expires. */
export const ZERO_DATE = "0001-01-01";

/** The file's problems, and the entries whose expiry has passed: Trivy no longer honors them. */
export interface IgnoreCheck {
  problems: string[];
  expired: string[];
}

export function parseDate(value: unknown): Date | null {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : value;
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null;
  }

  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? null : date;
}

/** One entry's verdict: its problems, and its name when its expiry has passed. */
function entryVerdict(
  entry: unknown,
  where: string,
  today: Date,
): { problems: string[]; expired: string | null } {
  if (!isMapping(entry)) {
    return {
      problems: [`${where}: must be a mapping with id, statement, and expired_at`],
      expired: null,
    };
  }

  const problems: string[] = [];
  const id = typeof entry.id === "string" && entry.id !== "" ? entry.id : null;
  const name = id === null ? where : `${where} (${id})`;
  if (id === null) {
    problems.push(`${where}: id must be a non-empty string`);
  }

  for (const key of Object.keys(entry)) {
    if (!(ENTRY_KEYS as readonly string[]).includes(key)) {
      problems.push(`${name}: unknown key ${key}`);
    }
  }

  if (typeof entry.statement !== "string" || entry.statement.trim() === "") {
    problems.push(`${name}: statement must say why the finding is accepted`);
  }

  const expiry = parseDate(entry.expired_at);
  if (expiry === null) {
    problems.push(
      `${name}: expired_at must be a YYYY-MM-DD date after which the finding blocks again`,
    );
    return { problems, expired: null };
  }

  if (expiry.toISOString().startsWith(ZERO_DATE)) {
    problems.push(
      `${name}: expired_at ${ZERO_DATE} is the zero date, which Trivy never expires; give the bypass a real date`,
    );
    return { problems, expired: null };
  }

  return { problems, expired: expiry.getTime() <= today.getTime() ? name : null };
}

export function checkIgnoreFile(text: string, today: Date): IgnoreCheck {
  const problems: string[] = [];
  const expired: string[] = [];
  let data: unknown;
  try {
    data = Bun.YAML.parse(text);
  } catch (err) {
    return {
      problems: [`not valid YAML: ${err instanceof Error ? err.message : String(err)}`],
      expired,
    };
  }

  if (!isMapping(data)) {
    return { problems: [`must be a mapping with the sections ${SECTIONS.join(", ")}`], expired };
  }

  for (const section of Object.keys(data)) {
    if (!(SECTIONS as readonly string[]).includes(section)) {
      problems.push(`${section}: not a Trivy ignore section (${SECTIONS.join(", ")})`);
    }
  }

  for (const section of SECTIONS) {
    const entries = data[section];
    if (entries === undefined || entries === null) {
      continue;
    }

    if (!Array.isArray(entries)) {
      problems.push(`${section}: must be a list of entries`);
      continue;
    }

    entries.forEach((entry, index) => {
      const verdict = entryVerdict(entry, `${section}[${index}]`, today);
      problems.push(...verdict.problems);
      if (verdict.expired !== null) {
        expired.push(verdict.expired);
      }
    });
  }

  return { problems, expired };
}

function main(): number {
  if (existsSync(PLAIN_IGNORE_FILE)) {
    error(
      `${PLAIN_IGNORE_FILE} is not honored: its entries never expire. Move each one into ${IGNORE_FILE} with a statement and an expired_at date.`,
      { file: PLAIN_IGNORE_FILE },
    );
    return 1;
  }

  if (!existsSync(IGNORE_FILE)) {
    setOutput("ignorefile", "");
    console.log(`no ${IGNORE_FILE}: nothing is bypassed`);
    return 0;
  }

  const today = new Date(new Date().toISOString().slice(0, 10));
  const { problems, expired } = checkIgnoreFile(readFileSync(IGNORE_FILE, "utf-8"), today);
  for (const problem of problems) {
    error(`${IGNORE_FILE}: ${problem}`, { file: IGNORE_FILE });
  }

  for (const name of expired) {
    warning(
      `${IGNORE_FILE}: ${name} has expired; Trivy no longer ignores it - fix the finding or delete the entry`,
    );
  }

  if (problems.length > 0) {
    return 1;
  }
  setOutput("ignorefile", IGNORE_FILE);
  console.log(`${IGNORE_FILE}: every entry carries a statement and an expiry`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (cause) {
    setFailed(messageOf(cause));
  }
}
