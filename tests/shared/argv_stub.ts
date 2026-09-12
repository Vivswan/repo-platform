// The script under test runs by the real interpreter's path, so only its
// children hit the stub.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ArgvStub {
  /** The directory to prepend to PATH. */
  bin: string;
  calls(): string[][];
}

/** `extraLines` is for a stub that must also write a file the script reads. */
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
