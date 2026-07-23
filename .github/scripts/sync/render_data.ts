// Builds the copier --data-file inputs for the retired-file cleanup's two
// clean renders: the OLD render replays the answers recorded before the
// update (non-underscore keys only), and the NEW render applies the live
// module/channel/private/description data on top of them.
//
// Usage:
//   bun .github/scripts/sync/render_data.ts --answers-old <file>
//     --out-old <file> --out-new <file> --modules <json-list>
//     --channel <name> --private <true|false> --description <text>
//
// Errors go to stderr as ::error:: workflow commands with a nonzero exit.

import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";

const FLAGS = [
  "--answers-old",
  "--out-old",
  "--out-new",
  "--modules",
  "--channel",
  "--private",
  "--description",
] as const;

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

function parseFlags(args: string[], allowed: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!allowed.includes(flag) || value === undefined) {
      fail(`unknown or valueless argument "${flag}" - allowed flags: ${allowed.join(", ")}`);
    }
    flags.set(flag, value);
  }
  return flags;
}

function main(args: string[]): void {
  const flags = parseFlags(args, FLAGS);
  const missing = FLAGS.filter((flag) => !flags.has(flag));
  if (missing.length > 0) {
    fail(`missing required flags: ${missing.join(", ")}`);
  }

  const answersPath = flags.get("--answers-old")!;
  let answers: unknown;
  try {
    answers = parse(readFileSync(answersPath, "utf-8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    fail(`${answersPath}: cannot read as YAML: ${detail}`);
  }
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    fail(`${answersPath}: top level must be a mapping`);
  }

  let modules: unknown;
  try {
    modules = JSON.parse(flags.get("--modules")!);
  } catch {
    fail(`--modules is not valid JSON: ${flags.get("--modules")}`);
  }
  if (!Array.isArray(modules) || !modules.every((entry) => typeof entry === "string")) {
    fail("--modules must be a JSON list of strings");
  }

  const data = Object.fromEntries(
    Object.entries(answers as Record<string, unknown>).filter(([key]) => !key.startsWith("_")),
  );
  writeFileSync(flags.get("--out-old")!, stringify(data));
  writeFileSync(
    flags.get("--out-new")!,
    stringify({
      ...data,
      modules,
      channel: flags.get("--channel")!,
      private: flags.get("--private") === "true",
      description: flags.get("--description")!,
    }),
  );
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
