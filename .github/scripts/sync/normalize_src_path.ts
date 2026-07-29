// Rewrites a .copier-answers.yml's `_src_path` to the canonical template
// source. The recorded value is target-controlled (and repos generated from
// a local checkout record a filesystem path), so the push sync never trusts
// it - it is normalized before any copier command runs.
//
// Usage:
//   bun .github/scripts/sync/normalize_src_path.ts --answers <file> --canonical <value>
//
// Prints the previously recorded value on stdout (the caller compares it to
// the canonical one to decide whether a normalization commit is needed).
// Errors go to stderr as ::error:: workflow commands with a nonzero exit.

import { readFileSync, writeFileSync } from "node:fs";
import { parseFlags } from "../shared/flags.ts";

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

function main(args: string[]): void {
  const flags = parseFlags(args, ["--answers", "--canonical"]);
  const answersPath = flags["--answers"];
  const canonical = flags["--canonical"];

  const text = readFileSync(answersPath, "utf-8");
  const match = text.match(/^_src_path:.*$/m);
  if (!match) {
    fail(`no _src_path line in ${answersPath}`);
  }
  console.log(match[0].replace(/^_src_path:\s*/, ""));
  writeFileSync(answersPath, text.replace(/^_src_path:.*$/m, `_src_path: ${canonical}`));
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
