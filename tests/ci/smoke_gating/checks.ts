// Evaluates expectation checks (tests/ci/smoke_gating/expectations.ts)
// against a rendered tree. Every failure in a batch is reported, not just
// the first, so one red row shows the whole shape it disagrees with.

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { type Check, type DocPath, Includes } from "./expectations.ts";

/** The path did not resolve: distinct from a key present with a null
 * value (`workflow_dispatch:` parses to null and IS defined). */
const MISSING: unique symbol = Symbol("missing");

export function valueAt(doc: unknown, path: DocPath): unknown | typeof MISSING {
  let current: unknown = doc;
  for (const key of path) {
    if (current === null || typeof current !== "object") return MISSING;
    if (!(key in (current as object))) return MISSING;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

/** Partial match: object keys are a subset, every expected array element
 * matches SOME actual element, Includes matches a substring, scalars are
 * strictly equal. */
export function matchesPartial(actual: unknown, expected: unknown): boolean {
  if (expected instanceof Includes) {
    return typeof actual === "string" && actual.includes(expected.text);
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.every((e) => actual.some((a) => matchesPartial(a, e)));
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    const record = actual as Record<string, unknown>;
    return Object.entries(expected).every(
      ([key, value]) => key in record && matchesPartial(record[key], value),
    );
  }
  return actual === expected;
}

/** Every key and scalar of a subtree, one per line: the text a substring
 * ban reads, with comments and quoting gone. */
export function flatten(value: unknown): string {
  if (Array.isArray(value)) return value.map(flatten).join("\n");
  if (value !== null && typeof value === "object") {
    return Object.entries(value)
      .map(([key, inner]) => `${key}\n${flatten(inner)}`)
      .join("\n");
  }
  return String(value);
}

function show(value: unknown): string {
  if (value === MISSING) return "no value at that path";
  if (value instanceof Includes) return `a string containing ${JSON.stringify(value.text)}`;
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner instanceof Includes ? `<contains ${inner.text}>` : inner,
  );
}

class Reporter {
  readonly failures: string[] = [];
  fail(path: string, expected: string, got: string): void {
    this.failures.push(`${path}: expected ${expected}; got ${got}`);
  }
}

function readText(root: string, path: string, report: Reporter): string | null {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch (error) {
    report.fail(path, "a readable file", error instanceof Error ? error.message : String(error));
    return null;
  }
}

function parsed(root: string, path: string, report: Reporter): unknown | typeof MISSING {
  const text = readText(root, path, report);
  if (text === null) return MISSING;
  try {
    return parseYaml(text);
  } catch (error) {
    report.fail(
      path,
      "parseable YAML/JSON",
      error instanceof Error ? error.message : String(error),
    );
    return MISSING;
  }
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function runCheck(root: string, check: Check, report: Reporter): void {
  switch (check.kind) {
    case "exists": {
      let isFile = false;
      try {
        isFile = statSync(join(root, check.path)).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) report.fail(check.path, "a rendered file", "none");
      return;
    }
    case "missing": {
      if (existsSync(join(root, check.path))) {
        report.fail(check.path, "nothing rendered", "a rendered path");
      }
      return;
    }
    case "symlink": {
      let target: string | null = null;
      try {
        if (lstatSync(join(root, check.path)).isSymbolicLink()) {
          target = readlinkSync(join(root, check.path));
        }
      } catch {
        target = null;
      }
      if (target !== check.target) {
        report.fail(check.path, `a symlink to ${check.target}`, target ?? "not a symlink");
      }
      return;
    }
    case "text": {
      const text = readText(root, check.path, report);
      if (text === null) return;
      const lines = text.split("\n");
      for (const needle of check.has ?? []) {
        if (!text.includes(needle)) report.fail(check.path, `to contain ${show(needle)}`, "absent");
      }
      for (const needle of check.lacks ?? []) {
        if (text.includes(needle))
          report.fail(check.path, `not to contain ${show(needle)}`, "present");
      }
      for (const line of check.hasLine ?? []) {
        if (!lines.includes(line)) report.fail(check.path, `a line exactly ${show(line)}`, "none");
      }
      for (const line of check.lacksLine ?? []) {
        if (lines.includes(line)) report.fail(check.path, `no line exactly ${show(line)}`, "one");
      }
      return;
    }
    case "count": {
      const text = readText(root, check.path, report);
      if (text === null) return;
      const got =
        "line" in check
          ? text.split("\n").filter((l) => l === check.line).length
          : countOf(text, check.substring);
      if (got !== check.expected) {
        const what = "line" in check ? `line ${show(check.line)}` : show(check.substring);
        report.fail(check.path, `exactly ${check.expected} of ${what}`, String(got));
      }
      return;
    }
    case "line-matching": {
      const text = readText(root, check.path, report);
      if (text === null) return;
      if (!text.split("\n").some((l) => check.pattern.test(l))) {
        report.fail(check.path, `a line matching ${check.pattern}`, "none");
      }
      return;
    }
    case "json": {
      const text = readText(root, check.path, report);
      if (text === null) return;
      try {
        JSON.parse(text);
      } catch (error) {
        report.fail(
          check.path,
          "valid JSON",
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }
    case "yaml-equals":
    case "yaml-matches":
    case "yaml-json":
    case "yaml-pluck": {
      const doc = parsed(root, check.path, report);
      if (doc === MISSING) return;
      const value = valueAt(doc, check.at);
      const where = `${check.path} at ${check.at.join(".") || "<root>"}`;
      switch (check.kind) {
        case "yaml-pluck": {
          if (!Array.isArray(value)) {
            report.fail(where, "a list", show(value));
            return;
          }
          const plucked = value.map((item) => check.pluck.map((sub) => valueAt(item, sub)));
          if (!Bun.deepEquals(plucked, check.equals, true)) {
            report.fail(where, `to project to ${show(check.equals)}`, show(plucked));
          }
          return;
        }
        case "yaml-json": {
          let decoded: unknown = MISSING;
          if (typeof value === "string") {
            try {
              decoded = JSON.parse(value);
            } catch {
              decoded = MISSING;
            }
          }
          if (decoded === MISSING || !Bun.deepEquals(decoded, check.equals, true)) {
            report.fail(where, `a JSON string decoding to ${show(check.equals)}`, show(value));
          }
          return;
        }
        case "yaml-matches":
          if (value === MISSING || !matchesPartial(value, check.matches)) {
            report.fail(where, `to match ${show(check.matches)}`, show(value));
          }
          return;
        case "yaml-equals":
          if (value === MISSING || !Bun.deepEquals(value, check.equals, true)) {
            report.fail(where, show(check.equals), show(value));
          }
          return;
      }
      return;
    }
    case "yaml-keys": {
      const doc = parsed(root, check.path, report);
      if (doc === MISSING) return;
      const value = valueAt(doc, check.at);
      const keys =
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? Object.keys(value)
          : MISSING;
      if (keys === MISSING || !Bun.deepEquals(keys, check.equals, true)) {
        report.fail(
          `${check.path} at ${check.at.join(".") || "<root>"}`,
          `exactly the keys ${show(check.equals)}`,
          keys === MISSING ? "not a mapping" : show(keys),
        );
      }
      return;
    }
    case "yaml-defined":
    case "yaml-absent": {
      const doc = parsed(root, check.path, report);
      if (doc === MISSING) return;
      const defined = valueAt(doc, check.at) !== MISSING;
      const want = check.kind === "yaml-defined";
      if (defined !== want) {
        report.fail(
          `${check.path} at ${check.at.join(".")}`,
          want ? "a defined key" : "no such key",
          defined ? "defined" : "undefined",
        );
      }
      return;
    }
    case "yaml-text": {
      const doc = parsed(root, check.path, report);
      if (doc === MISSING) return;
      const value = valueAt(doc, check.at);
      const where = `${check.path} at ${check.at.join(".")}`;
      if (value === MISSING) {
        report.fail(where, "a subtree", "no value at that path");
        return;
      }
      const text = flatten(value);
      for (const needle of check.has ?? []) {
        if (!text.includes(needle)) report.fail(where, `to contain ${show(needle)}`, "absent");
      }
      for (const needle of check.lacks ?? []) {
        if (text.includes(needle)) report.fail(where, `not to contain ${show(needle)}`, "present");
      }
      return;
    }
    case "outside-jobs": {
      const doc = parsed(root, check.path, report);
      if (doc === MISSING) return;
      if (doc === null || typeof doc !== "object") {
        report.fail(check.path, "a workflow mapping", show(doc));
        return;
      }
      const { jobs, ...rest } = doc as Record<string, unknown>;
      const kept = Object.fromEntries(
        Object.entries((jobs as Record<string, unknown> | undefined) ?? {}).filter(
          ([id]) => !check.jobs.includes(id),
        ),
      );
      const text = flatten({ ...rest, jobs: kept });
      for (const needle of check.lacks) {
        if (text.includes(needle)) {
          report.fail(
            check.path,
            `no ${show(needle)} outside the ${check.jobs.join(", ")} job(s)`,
            "present elsewhere",
          );
        }
      }
      return;
    }
    case "deno-fmt-prose-preserved": {
      const dir = join(root, check.dir);
      const workflows = readdirSync(dir).filter((name) => name.endsWith(".yml"));
      if (workflows.length === 0) report.fail(check.dir, "rendered workflows to sweep", "none");
      for (const name of workflows) {
        const lines = readFileSync(join(dir, name), "utf8").split("\n");
        for (const line of lines) {
          if (/deno\s+fmt/.test(line) && !line.includes("--prose-wrap preserve")) {
            report.fail(
              `${check.dir}/${name}`,
              "every deno fmt to carry --prose-wrap preserve",
              line.trim(),
            );
          }
        }
      }
      return;
    }
  }
}

/** Runs every check; throws once, naming every failure, when any fails. */
export function runChecks(root: string, checks: Check[], hint: string): void {
  const report = new Reporter();
  for (const check of checks) runCheck(root, check, report);
  if (report.failures.length > 0) {
    throw new Error(`gating check failed ${hint}:\n  ${report.failures.join("\n  ")}`);
  }
}
