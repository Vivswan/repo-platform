// actionlint over the caller's workflows, with the shellcheck and pyflakes it hands `run:` blocks to named by path:
// actionlint drops an integration whose command it cannot find and says so only in its verbose log, so a runner
// without one would lint less and stay green.

import { dirname, join } from "node:path";
import * as core from "@actions/core";
import * as toolCache from "@actions/tool-cache";
import {
  capture,
  messageOf,
  type RunResult,
  requireEnv,
  succeeded,
} from "../shared/action_runtime.ts";
import { type ReleaseBinary, setUpReleaseBinary, thisRunner } from "../shared/release_binary.ts";

type Arch = "X64" | "ARM64";

const LINT_BOUND_MS = 600_000;

/** The pinned rhysd/actionlint release: `sha256` holds each archive's digest under its `runner.arch`. */
export function actionlintRelease(version: string, sha256: Record<Arch, string>): ReleaseBinary {
  const archive = (arch: Arch, named: string) => ({
    url: `https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_linux_${named}.tar.gz`,
    sha256: sha256[arch],
    member: "actionlint",
  });
  return {
    name: "actionlint",
    version,
    versionArgs: ["-version"],
    versionPattern: /^v?(\S+)/,
    downloads: { X64: archive("X64", "amd64"), ARM64: archive("ARM64", "arm64") },
  };
}

/** The pinned koalaman/shellcheck release: `sha256` holds each archive's digest under its `runner.arch`. */
export function shellcheckRelease(version: string, sha256: Record<Arch, string>): ReleaseBinary {
  const archive = (arch: Arch, named: string) => ({
    url: `https://github.com/koalaman/shellcheck/releases/download/v${version}/shellcheck-v${version}.linux.${named}.tar.xz`,
    sha256: sha256[arch],
    member: `shellcheck-v${version}/shellcheck`,
  });
  return {
    name: "shellcheck",
    version,
    versionArgs: ["--version"],
    versionPattern: /^version: (\S+)$/m,
    downloads: { X64: archive("X64", "x86_64"), ARM64: archive("ARM64", "aarch64") },
  };
}

/** On every run, beside the repository's own config: actionlint's scope list lacks `vulnerability-alerts` (rhysd/actionlint#666); drop when it knows the scope. */
export const IGNORE_ARGS = ["-ignore", '^unknown permission scope "vulnerability-alerts"\\. '];

/** The commands one lint runs, each an absolute path. */
export interface Linters {
  actionlint: string;
  shellcheck: string;
  pyflakes: string;
}

/** actionlint's run over the workflows of the repository at `cwd`: findings on stdout, its verbose log on stderr. */
export function lint(linters: Linters, cwd: string): RunResult {
  return capture(
    [
      linters.actionlint,
      "-verbose",
      "-shellcheck",
      linters.shellcheck,
      "-pyflakes",
      linters.pyflakes,
      ...IGNORE_ARGS,
    ],
    { cwd, timeoutMs: LINT_BOUND_MS },
  );
}

/** Why the step fails, or undefined for a clean run. actionlint exits 1 on findings, and 2 or 3 when it could not lint. */
function failure(result: RunResult): string | undefined {
  if (succeeded(result.exit)) return undefined;

  if (result.exit.kind === "timed-out") return "actionlint timed out";

  if (result.exit.kind === "signaled") return `actionlint died on ${result.exit.signal}`;

  if (result.exit.code === 1) return "actionlint found problems in the workflows";

  return `actionlint could not lint (exit ${result.exit.code}); its log names the cause`;
}

function sha256Pins(tool: string): Record<Arch, string> {
  return { X64: requireEnv(`${tool}_SHA256_X64`), ARM64: requireEnv(`${tool}_SHA256_ARM64`) };
}

async function main(): Promise<void> {
  const runner = thisRunner();
  const actionlint = await setUpReleaseBinary(
    actionlintRelease(requireEnv("ACTIONLINT_VERSION"), sha256Pins("ACTIONLINT")),
    runner,
    toolCache,
  );
  const shellcheck = await setUpReleaseBinary(
    shellcheckRelease(requireEnv("SHELLCHECK_VERSION"), sha256Pins("SHELLCHECK")),
    runner,
    toolCache,
  );
  for (const tool of [actionlint, shellcheck]) {
    if (tool.installed) core.addPath(dirname(tool.path));
  }
  const pyflakes = Bun.which("pyflakes");
  if (pyflakes === null) {
    throw new Error("pyflakes is not on PATH: this script runs under the action's uv project");
  }

  // The matcher stays registered for the job: a later step that runs actionlint is annotated by it too.
  core.info(`::add-matcher::${join(import.meta.dir, "actionlint-matcher.json")}`);
  const result = lint(
    { actionlint: actionlint.path, shellcheck: shellcheck.path, pyflakes },
    process.cwd(),
  );
  if (result.stdout.trim() !== "") core.info(result.stdout.trimEnd());
  core.startGroup("actionlint's log");
  core.info(result.stderr.trimEnd());
  core.endGroup();
  const failed = failure(result);
  if (failed !== undefined) core.setFailed(failed);
}

if (import.meta.main) {
  try {
    await main();
  } catch (cause) {
    core.setFailed(messageOf(cause));
  }
}
