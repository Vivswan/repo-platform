import { parseRegistration, type Registration } from "../../../../actions/plan/registration.ts";
import { REGISTRATION_PATH } from "../../../../actions/shared/platform.ts";
import type { PlaceholderName, PlaceholderValues } from "./placeholders.ts";
import { existingFile } from "./target_files.ts";

/** The grammar names the file in every message, so none is prefixed here. A module name files.yml does not know is judged there, not here. */
export function readRegistration(target: string): Registration {
  const bytes = existingFile(target, REGISTRATION_PATH);
  if (bytes === null) throw new Error(`${REGISTRATION_PATH}: missing from the target repository`);
  const read = parseRegistration(bytes.toString("utf-8"));
  if ("errors" in read) throw new Error(read.errors.join("\n"));
  return read.registration;
}

export const PLACEHOLDER_SOURCE: Record<PlaceholderName, string> = {
  project_name: "project.name",
  project_slug: "project.slug",
  description: "project.description",
  github_username: "the repository slug",
  github_username_lower: "the repository slug",
  copyright_holder: "project.copyright_holder",
  year: "the clock",
  private: "the writer's --private flag",
  fuzzer_label: "labels.fuzzer (or the fuzzer module's tracking_label default)",
  fuzzer_label_color: "the fuzzer module's tracking_label color",
  fuzzer_label_description: "the fuzzer module's tracking_label description",
  nightly_label: "labels.nightly (or the nightly module's tracking_label default)",
  nightly_label_color: "the nightly module's tracking_label color",
  nightly_label_description: "the nightly module's tracking_label description",
  site_label: "labels.site (or the site module's tracking_label default)",
  site_label_color: "the site module's tracking_label color",
  site_label_description: "the site module's tracking_label description",
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

/** The registration never names its own owner, so the slug comes from the operator. A tracking label absent from both the registration and files.yml's module default stays absent:
 *  sync.ts then refuses any listed source that uses it (placeholders.ts, missingPlaceholders). The label's color and description are files.yml's alone. */
export function placeholderValues(
  registration: Registration,
  repository: RepositorySlug,
  isPrivate: boolean,
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
    private: String(isPrivate),
  };
  const optional: Partial<Record<PlaceholderName, string | undefined>> = {
    ...defaults,
    fuzzer_label: labels.fuzzer ?? defaults.fuzzer_label,
    nightly_label: labels.nightly ?? defaults.nightly_label,
    site_label: labels.site ?? defaults.site_label,
  };
  for (const [name, value] of Object.entries(optional)) {
    if (value !== undefined) values[name as PlaceholderName] = value;
  }
  return values;
}
