// commitlint in this process, over the config beside this file. The commit-msg hook (scripts/check/check_commit_subject.ts)
// imports it from here: an action resolves imports from its own directory alone, and node_modules sits in this directory.
// Not the CLI as a child: a report crossing a pipe was cut (the CLI exits before its pipe drains, and a capture has a
// byte cap), and the CLI drops a whitespace-only message before any rule sees it.

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import format from "@commitlint/format";
import lint from "@commitlint/lint";
import load from "@commitlint/load";

const CONFIG = fileURLToPath(new URL("commitlint.config.mjs", import.meta.url));
const loaded = await load({}, { file: CONFIG, cwd: dirname(CONFIG) });
// load() reads a preset's parser options as unknown; lint() takes them typed.
type LintOptions = NonNullable<Parameters<typeof lint>[2]>;

export interface Verdict {
  status: number;
  /** commitlint's report, returned so a caller judging several candidates prints only the one it settles on. */
  report: string;
}

/** The message must hold a non-blank line: commitlint's parser throws on a whitespace-only one. */
export async function commitlint(message: string): Promise<Verdict> {
  const result = await lint(message, loaded.rules, {
    parserOpts: loaded.parserPreset?.parserOpts as LintOptions["parserOpts"],
    plugins: loaded.plugins,
    ignores: loaded.ignores,
    defaultIgnores: loaded.defaultIgnores,
  });
  return {
    status: result.valid ? 0 : 1,
    report: format({ results: [result] }, { helpUrl: loaded.helpUrl }),
  };
}

/** fs.writeSync on a pipe stops at the pipe's capacity and only reports the short count; the stream write finishes
 *  the whole text before its callback. Callers exit naturally (process.exitCode), so nothing cuts a queued write. */
export function writeStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
  });
}
