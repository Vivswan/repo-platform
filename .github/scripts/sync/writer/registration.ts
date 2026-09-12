// The target repository's registration, read from its checkout through the
// fleet grammar (actions/plan/registration.ts), and the placeholder values
// the writer derives from it plus the repository slug the operator passes
// (the registration never names its own owner) and the module-declared
// defaults files.yml carries for the tracking labels it may leave unset.

import { parseRegistration, type Registration } from "../../../../actions/plan/registration.ts";
import { REGISTRATION_PATH } from "../../../../actions/shared/platform.ts";
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

/** A tracking label absent from both the registration and files.yml's module default stays absent:
 *  sync.ts then refuses any listed source that uses it (placeholders.ts, missingPlaceholders). */
export function placeholderValues(
  registration: Registration,
  repository: RepositorySlug,
  defaults: PlaceholderValues = {},
  now: Date = new Date(),
): PlaceholderValues {
  const project = registration.project;
  const labels = registration.labels ?? {};
  const values: PlaceholderValues = {
    project_name: project.name,
    project_slug: project.slug,
    description: project.description,
    github_username: repository.owner,
    github_username_lower: repository.owner.toLowerCase(),
    copyright_holder: project.copyright_holder ?? repository.owner,
    year: String(now.getUTCFullYear()),
  };
  const optional: Partial<Record<PlaceholderName, string | undefined>> = {
    fuzzer_label: labels.fuzzer ?? defaults.fuzzer_label,
    nightly_label: labels.nightly ?? defaults.nightly_label,
    site_label: labels.site ?? defaults.site_label,
  };
  for (const [name, value] of Object.entries(optional)) {
    if (value !== undefined) values[name as PlaceholderName] = value;
  }
  return values;
}
