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
import { parseFlags } from "../shared/flags.ts";

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

function main(args: string[]): void {
  const flags = parseFlags(args, FLAGS);

  const answersPath = flags["--answers-old"];
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
    modules = JSON.parse(flags["--modules"]);
  } catch {
    fail(`--modules is not valid JSON: ${flags["--modules"]}`);
  }
  if (!Array.isArray(modules) || !modules.every((entry) => typeof entry === "string")) {
    fail("--modules must be a JSON list of strings");
  }

  const data = Object.fromEntries(
    Object.entries(answers as Record<string, unknown>).filter(([key]) => !key.startsWith("_")),
  );
  writeFileSync(flags["--out-old"], stringify(data));
  writeFileSync(
    flags["--out-new"],
    stringify({
      ...data,
      modules,
      channel: flags["--channel"],
      private: flags["--private"] === "true",
      description: flags["--description"],
    }),
  );
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
