// Builds the copier --data-file inputs for the sync's two clean renders:
// the OLD render replays the answers recorded before the update
// (non-underscore keys only), and the NEW render applies the live
// module/private/description data on top of them.
//
// The recorded answers ride through VERBATIM (answers_file.ts's
// dataFileYaml): copier re-parses the data file with PyYAML (YAML 1.1),
// and the renders must be byte-identical to what `copier update` rendered
// from the same answers - so each recorded scalar must reach copier as the
// exact bytes the answers file held, never a re-typed re-dump (which would
// turn 1e3 into 1000 and a bare short sha into a float). The live values
// are serialized in PyYAML-safe forms and the assembled document is
// postcondition-checked there.
//
// Usage:
//   bun .github/scripts/sync/render_data.ts --answers-old <file>
//     --out-old <file> --out-new <file> --modules <json-list>
//     --private <true|false> --description <text>
//
// Errors print as ::error:: workflow commands (on stdout, where the
// runner parses them) with a nonzero exit.

import { readFileSync, writeFileSync } from "node:fs";
import { parseFlags } from "../shared/flags.ts";
import { fail } from "../shared/gha.ts";
import { parseModules } from "../shared/modules.ts";
import { dataFileYaml } from "./answers_file.ts";

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

  const modules = parseModules(flags["--modules"]);
  if (modules === null) {
    fail(`--modules must be a JSON list of strings: ${flags["--modules"]}`);
  }

  const answersPath = flags["--answers-old"];
  let dataOld: string;
  let dataNew: string;
  try {
    const text = readFileSync(answersPath, "utf-8");
    dataOld = dataFileYaml(text, null);
    dataNew = dataFileYaml(text, {
      modules,
      private: flags["--private"] === "true",
      description: flags["--description"],
    });
  } catch (err) {
    fail(`${answersPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  writeFileSync(flags["--out-old"], dataOld);
  writeFileSync(flags["--out-new"], dataNew);
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
