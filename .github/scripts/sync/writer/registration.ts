// The target repository's registration, read from its checkout through the
// fleet grammar (actions/plan/registration.ts), and the placeholder values
// the writer derives from it plus the repository slug the operator passes
// (the registration never names its own owner) and the module-declared
// defaults files.yml carries for what the registration may leave unset.

import {
  parseRegistration,
  REGISTRATION_PATH,
  type Registration,
} from "../../../../actions/plan/registration.ts";
import type { PlaceholderName, PlaceholderValues } from "./placeholders.ts";
import { existingFile } from "./target_files.ts";

/** The registration the target declares. A malformed one is a hard error:
 *  the grammar names the file in every message, and a module name it does
 *  not know is not an error here (files.yml decides which names it knows). */
export function readRegistration(target: string): Registration {
  const bytes = existingFile(target, REGISTRATION_PATH);
  if (bytes === null) throw new Error(`${REGISTRATION_PATH}: missing from the target repository`);
  const read = parseRegistration(bytes.toString("utf-8"));
  if ("errors" in read) throw new Error(read.errors.join("\n"));
  return read.registration;
}

/** Where the registration sets each placeholder the writer cannot fall
 *  back for, named in the report when the value is missing. */
export const PLACEHOLDER_SOURCE: Record<PlaceholderName, string> = {
  project_name: "project.name",
  project_slug: "project.slug",
  description: "project.description",
  github_username: "the repository slug",
  github_username_lower: "the repository slug",
  copyright_holder: "project.copyright_holder",
  year: "the clock",
  skills_dir: "skills.dir (or the skills module's skills_dir default)",
  fuzzer_label: "labels.fuzzer (or the fuzzer module's tracking_label default)",
  nightly_label: "labels.nightly (or the nightly module's tracking_label default)",
  site_label: "labels.site (or the site module's tracking_label default)",
};

export interface RepositorySlug {
  owner: string;
  name: string;
}

export function parseRepositorySlug(slug: string): RepositorySlug {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/.exec(slug);
  if (match === null) throw new Error(`repository must be owner/name, got '${slug}'`);
  return { owner: match[1], name: match[2] };
}

/** The values for every placeholder: the project block when the
 *  registration carries one, the repository name otherwise; the year is
 *  the current UTC year; the skills directory and each tracking label are
 *  the registration's own value, else the module default files.yml
 *  declares, else absent (no listed source may use them then). */
export function placeholderValues(
  registration: Registration,
  repository: RepositorySlug,
  defaults: PlaceholderValues = {},
  now: Date = new Date(),
): PlaceholderValues {
  const project = registration.project;
  const labels = registration.labels ?? {};
  const values: PlaceholderValues = {
    project_name: project?.name ?? repository.name,
    project_slug: project?.slug ?? repository.name,
    description: project?.description ?? "",
    github_username: repository.owner,
    github_username_lower: repository.owner.toLowerCase(),
    copyright_holder: project?.copyright_holder ?? repository.owner,
    year: String(now.getUTCFullYear()),
  };
  const optional: Partial<Record<PlaceholderName, string | undefined>> = {
    skills_dir: registration.skills?.dir ?? defaults.skills_dir,
    fuzzer_label: labels.fuzzer ?? defaults.fuzzer_label,
    nightly_label: labels.nightly ?? defaults.nightly_label,
    site_label: labels.site ?? defaults.site_label,
  };
  for (const [name, value] of Object.entries(optional)) {
    if (value !== undefined) values[name as PlaceholderName] = value;
  }
  return values;
}
