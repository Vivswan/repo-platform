// The target repository's registration, read from its checkout through the
// fleet grammar (actions/plan/registration.ts), and the placeholder values
// the writer derives from it plus the repository slug the operator passes
// (the registration never names its own owner).

import {
  parseRegistration,
  REGISTRATION_PATH,
  type Registration,
} from "../../../../actions/plan/registration.ts";
import type { PlaceholderValues } from "./placeholders.ts";
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
