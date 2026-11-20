// actionlint drops its shellcheck or pyflakes integration when it cannot find the command, and says so only in its
// verbose log: a lint that named neither by path would pass every `run:` block unread on a runner without them. Each
// row plants an actionlint that reports how it was called, and reads the whole call or the whole verdict.

import { describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  actionlintRelease,
  lint,
  shellcheckRelease,
} from "../../../actions/actionlint/actionlint.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const PINS = { X64: "a".repeat(64), ARM64: "b".repeat(64) };

describe("lint", () => {
  test("actionlint runs at the repository's root with shellcheck and pyflakes named by path", () => {
    const root = realpathSync(temp.dir("actionlint-"));
    const actionlint = join(root, "actionlint");
    writeFileSync(actionlint, '#!/bin/sh\npwd\nprintf "%s\\n" "$@"\necho log >&2\nexit 1\n', {
      mode: 0o755,
    });
    const result = lint(
      { actionlint, shellcheck: "/tools/shellcheck", pyflakes: "/venv/pyflakes" },
      root,
    );
    expect(result).toEqual({
      exit: { kind: "exited", code: 1 },
      stdout: `${root}\n-verbose\n-shellcheck\n/tools/shellcheck\n-pyflakes\n/venv/pyflakes\n-ignore\n^unknown permission scope "vulnerability-alerts"\\. \n`,
      stderr: "log\n",
    });
  });
});

describe("the pinned releases", () => {
  test("actionlint's version is the first line it prints, the install and build lines ignored", () => {
    const printed =
      "1.7.12\ninstalled by downloading from release page\nbuilt with go1.26.1 compiler for linux/arm64\n";
    expect(actionlintRelease("1.7.12", PINS).versionPattern.exec(printed)?.[1]).toBe("1.7.12");
  });

  test("shellcheck's version is read from its own line, under the banner", () => {
    const printed =
      "ShellCheck - shell script analysis tool\nversion: 0.9.0\nlicense: GNU General Public License, version 3\nwebsite: https://www.shellcheck.net\n";
    expect(shellcheckRelease("0.9.0", PINS).versionPattern.exec(printed)?.[1]).toBe("0.9.0");
  });
});
