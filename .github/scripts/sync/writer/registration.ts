// The target repository's registration, read from its checkout, and the
// placeholder values the writer derives from it plus the repository slug
// the operator passes (the registration never names its own owner).

import { parseRegistration, type Registration } from "../../../../actions/shared/registration.ts";
import type { PlaceholderValues } from "./placeholders.ts";
import { existingFile } from "./target_files.ts";

export const REGISTRATION_FILE = ".repo-platform.yml";

export function readRegistration(target: string): Registration {
  const bytes = existingFile(target, REGISTRATION_FILE);
  if (bytes === null) throw new Error(`${REGISTRATION_FILE}: missing from the target repository`);
  return parseRegistration(bytes.toString("utf-8"));
}

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
 *  the current UTC year. */
export function placeholderValues(
  registration: Registration,
  repository: RepositorySlug,
  now: Date = new Date(),
): PlaceholderValues {
  const project = registration.project;
  return {
    project_name: project?.name ?? repository.name,
    project_slug: project?.slug ?? repository.name,
    description: project?.description ?? "",
    github_username: repository.owner,
    github_username_lower: repository.owner.toLowerCase(),
    copyright_holder: project?.copyright_holder ?? repository.owner,
    year: String(now.getUTCFullYear()),
  };
}
