// What the module-render check reads off the tree it judges: the recorded
// build sha, the module selection, and the two answers the sync feeds
// copier as live data. The admission and the render read through this one
// function, so they cannot judge different facts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { recordedBuildSha } from "../../shared/build_sha.ts";

export const REGISTRATION_PATH = ".repo-platform.yml";
export const ANSWERS_PATH = ".github/.copier-answers.yml";

/** The files whose change in a pull request means the render must follow:
 *  the selection itself and the recorded answers the render reads. */
export const SELECTION_PATHS: readonly string[] = [REGISTRATION_PATH, ANSWERS_PATH];

export interface Selection {
  /** The full build sha the tree records; the render runs at this commit. */
  commit: string;
  modules: string[];
  private: boolean;
  description: string;
}

export type SelectionRead = { selection: Selection } | { refusal: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A YAML mapping at `rel` under root, or null when the file is missing,
 *  does not parse, or is not a mapping. logLevel error keeps the parser
 *  from printing source lines on warnings. */
function mapping(root: string, rel: string): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = parseYaml(readFileSync(join(root, rel), "utf-8"), { logLevel: "error" });
  } catch {
    return null;
  }
  return isRecord(data) ? data : null;
}

/** The selection the tree at `root` declares, or a one-line refusal (no
 *  trailing period). The shape checks stay minimal on purpose: the
 *  validate-template job reports the registration and answers files'
 *  problems in full, and copier refuses a name its template does not offer. */
export function readSelection(root: string): SelectionRead {
  const sha = recordedBuildSha(root);
  if ("refusal" in sha) return sha;
  const registration = mapping(root, REGISTRATION_PATH);
  if (registration === null) {
    return { refusal: `${REGISTRATION_PATH} is missing or is not a YAML mapping` };
  }
  const modules = registration.modules;
  if (
    !Array.isArray(modules) ||
    !modules.every((name): name is string => typeof name === "string" && name !== "")
  ) {
    return {
      refusal: `${REGISTRATION_PATH}: top-level modules must be a list of module names`,
    };
  }
  const answers = mapping(root, ANSWERS_PATH);
  if (answers === null) return { refusal: `${ANSWERS_PATH} is missing or is not a YAML mapping` };
  return {
    selection: {
      commit: sha.sha,
      modules,
      private: answers.private === true,
      description: typeof answers.description === "string" ? answers.description : "",
    },
  };
}
