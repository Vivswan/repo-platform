// Builds the copier --data-file inputs for the retired-file cleanup's two
// clean renders: the OLD render replays the answers recorded before the
// update (non-underscore keys only), and the NEW render applies the live
// module/private/description data on top of them.
//
// Usage:
//   bun .github/scripts/sync/render_data.ts --answers-old <file>
//     --out-old <file> --out-new <file> --modules <json-list>
//     --private <true|false> --description <text>
//
// Errors print as ::error:: workflow commands (on stdout, where the
// runner parses them) with a nonzero exit.

import { writeFileSync } from "node:fs";
import { stringify } from "yaml";
import { parseFlags } from "../shared/flags.ts";
import { fail } from "../shared/gha.ts";
import { parseModules } from "../shared/modules.ts";
import { readAnswersFile } from "./answers_file.ts";

const FLAGS = [
  "--answers-old",
  "--out-old",
  "--out-new",
  "--modules",
  "--private",
  "--description",
] as const;

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
      private: flags["--private"] === "true",
      description: flags["--description"],
    }),
  );
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
