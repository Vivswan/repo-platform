// The split build: the fresh build with every split-class file's managed
// region changed (a line above AGENTS.md's, CODEOWNERS's, and LICENSE.md's
// END marker, an entry inside .gitignore's managed section), committed on
// the new build. The split-file rebuild leg updates INTO it so the managed
// half really moves under the repository-owned sides; the unselected-path
// leg rides the same content-changed build.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { editText, insertAfterLine, insertBeforeLine } from "./edits";
import { type Build, type Fixture, MARKERS } from "./fixture";

export const SPLIT_MANAGED_LINES = {
  agents: "Split-rebuild fixture managed line (agents).",
  codeowners: "# Split-rebuild fixture managed line (codeowners).",
  license: "Split-rebuild fixture managed line (license).",
  gitignore: "split-rebuild-fixture.tmp",
} as const;

function insertAboveEndMarker(
  template: string,
  line: string,
  end: string = MARKERS.html.end,
): void {
  editText(template, (text) =>
    insertBeforeLine(
      text,
      (candidate) => candidate === end,
      [line],
      `perturb the managed region of ${template}`,
    ),
  );
}

/** The one AGENTS.md template at the top of the composed tree. */
function agentsTemplate(tree: string): string {
  const templateDir = join(tree, "template");
  const name = readdirSync(templateDir)
    .filter((entry) => entry.includes("AGENTS.md") && entry.endsWith(".jinja"))
    .sort()[0];
  if (name === undefined) throw new Error("no AGENTS.md template in the assembled build tree");
  return join(templateDir, name);
}

export function commitSplitBuild(fx: Fixture): Build {
  const tree = fx.copyNewTree("next-split");
  insertAboveEndMarker(agentsTemplate(tree), SPLIT_MANAGED_LINES.agents);
  insertAboveEndMarker(
    join(tree, "template/.github/CODEOWNERS.jinja"),
    SPLIT_MANAGED_LINES.codeowners,
    MARKERS.hash.end,
  );
  // The fleet LICENSE's managed region moves too: the materialized mirrors
  // must carry the NEW bytes, not the last delivered copy.
  insertAboveEndMarker(join(tree, "template/LICENSE.md.jinja"), SPLIT_MANAGED_LINES.license);
  editText(join(tree, "template/.gitignore.jinja"), (text) =>
    insertAfterLine(
      text,
      (line) => line === MARKERS.hash.begin,
      [SPLIT_MANAGED_LINES.gitignore],
      "perturb .gitignore's managed section",
    ),
  );
  return fx.commitBuildTree(tree, "split", fx.new);
}
