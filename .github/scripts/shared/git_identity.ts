// The bot identities this repository commits with, owned here alone.
// Every committer is a TypeScript script that imports these constants, so
// no other copy exists to police.

export interface GitIdentity {
  name: string;
  email: string;
}

/** The push sync's committer: sync-branch commits into managed repos and
 * this repo's own automation commits. */
export const SYNC_IDENTITY: GitIdentity = {
  name: "repo-platform-sync",
  email: "repo-platform-sync@users.noreply.github.com",
};

/** The build-branches publisher's committer, deliberately distinct from
 * the sync's: build commits on the orphan branches name their producer. */
export const BUILD_IDENTITY: GitIdentity = {
  name: "repo-platform-build",
  email: "repo-platform-build@users.noreply.github.com",
};

/** Per-invocation `-c` config arguments, for git commands that must not
 * write the identity into the repository's config. */
export function identityArgs(identity: GitIdentity): string[] {
  return ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
}
