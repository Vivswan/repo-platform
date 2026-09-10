// A stub executable on PATH that records every argv it is invoked with
// (its own name as argv[0]) and exits STUB_EXIT: the harness for step
// scripts whose whole behavior is the subprocess they spawn. The script
// under test runs by the real interpreter's path, so only its children
// hit the stub.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ArgvStub {
  /** The directory to prepend to PATH. */
  bin: string;
  /** Every recorded invocation, in order, each as its whole argv. */
  calls(): string[][];
}

/** Installs `<root>/bin/<name>`; `extraLines` run after the recording
 *  and before the exit (a stub that also writes a file the script reads). */
export function argvStub(root: string, name: string, extraLines: string[] = []): ArgvStub {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(root, `${name}-calls.log`);
  writeFileSync(
    join(bin, name),
    [
      "#!/usr/bin/env bash",
      `{ printf '%s' ${JSON.stringify(name)}; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>${JSON.stringify(log)}`,
      ...extraLines,
      'exit "${STUB_EXIT:-0}"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(log, "");
  return {
    bin,
    calls: () =>
      readFileSync(log, "utf-8")
        .split("\x1e")
        .slice(0, -1)
        .map((record) => record.split("\x1f")),
  };
}
