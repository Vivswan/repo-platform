// Every committer is a TypeScript script importing these constants; no workflow or action carries its own copy.

export interface GitIdentity {
  name: string;
  email: string;
}

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
