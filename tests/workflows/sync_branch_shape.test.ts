// The label the sync-branch job's condition reads must be one the baseline settings layer declares: the nightly apply
// deletes undeclared labels, so a label named in one place alone is deleted the night it is used. Three files hold
// the name as a literal and none can see the others (docs/platform/sync/operator.md, "Syncing a branch by label").

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PLATFORM_OWNER, SYNC_LABEL } from "../../actions/shared/platform.ts";

const ROOT = join(import.meta.dir, "../..");

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("the label the sync-branch condition reads is the platform's, and the baseline layer declares it", () => {
  const workflow = parseYaml(
    read("files/base/.github/workflows/sync-branch.yml").replaceAll(
      "{{github_username}}",
      PLATFORM_OWNER,
    ),
  ) as { jobs: Record<string, { if?: string }> };
  const baseline = parseYaml(read("files/settings/baseline.yml")) as {
    labels: { name: string }[];
  };
  const conditions = Object.values(workflow.jobs).map((job) => job.if ?? "");
  expect({
    labelsRead: conditions.flatMap((condition) =>
      [...condition.matchAll(/github\.event\.label\.name == '([^']+)'/g)].map((match) => match[1]),
    ),
    declared: baseline.labels.filter((label) => label.name === SYNC_LABEL).length,
  }).toEqual({ labelsRead: [SYNC_LABEL], declared: 1 });
});
