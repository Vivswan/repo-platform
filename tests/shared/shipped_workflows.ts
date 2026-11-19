// Which files under files/ are workflows a target receives and which workflow a `uses:` line calls, for the tests that
// walk the shipped workflows: one reading of the tree and of a call's spelling, so two walks cannot disagree on either.

import { globSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseFilesConfig } from "../../actions/plan/files_config.ts";
import { PLATFORM_SLUG } from "../../actions/shared/platform.ts";
import { shippedSource } from "./shipped_source.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const LOCAL_CALL = /^[.$]\/\.github\/workflows\/(.+)$/;

/** A call of one of this repository's workflows from another repository, at a ref. */
export const PLATFORM_CALL = new RegExp(`^${PLATFORM_SLUG}/(\\.github/workflows/.+)@`);

/** A reusable workflow of this repository, whichever spelling the caller uses; null for a third-party call. A `./` or
 *  `$/` call resolves against `callerDir`: the fleet's ci.yml calls the starters beside it with `./`, this repository's
 *  workflows call each other with `$/`. A qualified call names this repository's own workflow. */
export function calledWorkflow(uses: string, callerDir: string): string | null {
  const local = LOCAL_CALL.exec(uses);
  if (local !== null) return `${callerDir}/${local[1]}`;
  return PLATFORM_CALL.exec(uses)?.[1] ?? null;
}

/** The step lists files.yml splices into a workflow, by repository path: each indented for its `{{blocks}}` line, and
 *  no workflow on its own. */
export const WORKFLOW_FRAGMENTS = new Set(
  parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf8")).files.flatMap((entry) =>
    "sources" in entry && entry.path.startsWith(".github/workflows/")
      ? Object.values(entry.sources).flatMap((source) =>
          typeof source === "string" ? [`files/${source}`] : [],
        )
      : [],
  ),
);

/** Every file under a module's .github/workflows, by repository path, the fragments among them. */
export function shippedWorkflowFiles(): string[] {
  return globSync("files/*/.github/workflows/*.{yml,yaml}", { cwd: REPO_ROOT }).sort();
}

/** A workflow's jobs by id, as a target's copy parses. */
export function shippedJobs<Job>(rel: string): [string, Job][] {
  return Object.entries((parseYaml(shippedSource(rel)) as { jobs: Record<string, Job> }).jobs);
}

/** Every workflow a managed repository's run executes: the sources it receives whole and each platform workflow reached
 *  from them through the `uses:` lines, each once, so a new workflow is walked without being registered. */
export function executedWorkflowFiles(): string[] {
  const sources = shippedWorkflowFiles().filter((rel) => !WORKFLOW_FRAGMENTS.has(rel));
  const seen = new Set(sources);
  const queue = [...sources];
  for (let rel = queue.pop(); rel !== undefined; rel = queue.pop()) {
    for (const [, job] of shippedJobs<{ uses?: string }>(rel)) {
      // A source's `./` call names another source, whichever module ships it, and every source is walked already.
      const called = calledWorkflow(job.uses ?? "", dirname(rel));
      if (called === null || called.startsWith("files/") || seen.has(called)) continue;

      seen.add(called);
      queue.push(called);
    }
  }
  return [...seen].sort();
}
