// GitHub's default is `cancel-in-progress: false`: a lane that queues says nothing, and only a lane that cancels
// carries the key. The roster below is every workflow that cancels; ci.yml's expression form is pinned in
// post_green_shape.test.ts.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseFilesConfig, SOURCE_PREFIX } from "../../actions/plan/files_config";
import { REPO_ROOT } from "../shared/action_step";

const CANCELLING = [
  "files/base/.github/workflows/auto-format.yml",
  "files/deno/.github/workflows/deno-audit.yml",
];
const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;

interface Workflow {
  concurrency?: { "cancel-in-progress"?: unknown };
  jobs?: Record<string, { concurrency?: { "cancel-in-progress"?: unknown } }>;
}

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf-8");

/** Every workflow this repository runs or ships: its own, and each files.yml workflow entry's source. */
function workflows(): string[] {
  const own = readdirSync(join(REPO_ROOT, ".github/workflows"))
    .map((name) => `.github/workflows/${name}`)
    .filter((rel) => WORKFLOW_PATH.test(rel));
  const shipped = parseFilesConfig(read("files.yml")).files.flatMap((entry) =>
    WORKFLOW_PATH.test(entry.path) && "source" in entry ? [`${SOURCE_PREFIX}${entry.source}`] : [],
  );
  return [...own, ...shipped].sort();
}

/** The `cancel-in-progress` values a workflow spells, at the workflow and at each job. */
function cancelValues(rel: string): unknown[] {
  // A block placeholder holds a whole line, a value placeholder a word; concurrency lives in neither.
  const source = read(rel)
    .replaceAll(/^\{\{[a-z_]+\}\}\n/gm, "")
    .replaceAll(/\{\{[a-z_]+\}\}/g, "owner");
  const doc = parseYaml(source) as Workflow;
  return [doc, ...Object.values(doc.jobs ?? {})]
    .map((holder) => holder.concurrency?.["cancel-in-progress"])
    .filter((value) => value !== undefined);
}

test("no workflow spells cancel-in-progress: false; true only on the cancelling lanes", () => {
  const spelled = { false: [] as string[], true: [] as string[] };
  for (const rel of workflows()) {
    for (const value of cancelValues(rel)) {
      if (value === false) spelled.false.push(rel);
      if (value === true) spelled.true.push(rel);
    }
  }
  expect(spelled.false).toEqual([]);
  expect([...new Set(spelled.true)]).toEqual(CANCELLING);
});
