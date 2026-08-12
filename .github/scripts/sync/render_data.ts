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

import { writeFileSync } from "node:fs";
import { stringify } from "yaml";
import { parseFlags } from "../shared/flags.ts";
import { parseModules } from "../shared/modules.ts";
import { readAnswersFile } from "./answers_file.ts";

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
  let answers: Record<string, unknown>;
  try {
    answers = readAnswersFile(answersPath).fields;
  } catch (err) {
    fail(`${answersPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const modules = parseModules(flags["--modules"]);
  if (modules === null) {
    fail(`--modules must be a JSON list of strings: ${flags["--modules"]}`);
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
