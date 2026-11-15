---
order: 120
---

# npm

This page is the `npm` module's guide: what a repository sets up to publish one npm package, when each channel publishes, and what the publish refuses. Release-please itself is [all-green.md](../all-green.md#after-the-gate)'s.

```text
main:        A docs    B refactor    C fix                                  release PR merged
release PR:    -           -         refreshed (1.2.1)                      cut v1.2.1
latest:      1.2.0       1.2.0       1.2.0                                  1.2.1
next:        1.2.0       1.2.0       1.2.1-main.57.20261114.g3f9c2ab        1.2.1
```

After `1.2.0`, commits A and B change nothing a release would carry, so release-please leaves its PR alone and npm gets nothing. C is a fix: the release PR refreshes, and C's build goes to `next` as a pre-release of the `1.2.1` that PR will cut. Merging the release PR publishes `1.2.1` to `latest` and moves `next` to it.

| Channel  | Publishes when                                                                 | Version                                                       | Install                   |
| -------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------- |
| `latest` | release-please cuts a release                                                  | the one release-please wrote, `X.Y.Z`                         | `npm install <name>`      |
| `next`   | a push to main creates or refreshes the release PR (`prs_created`), never else | `X.Y.Z-main.<count>.<date>.g<sha7>`, `X.Y.Z` the release PR's | `npm install <name>@next` |

**`next` is never older than `latest`:** a release moves `next` to itself, and each release-PR refresh after it moves `next` on.

## Set it up

1. **Select the module** with `release-please`, in `.repo-platform.yml`:

   ```yaml
   modules: [bun, release-please, npm]
   npm:
     path: packages/cli # only when package.json is not at the repository root
   ```

2. **Let release-please write the version** into that `package.json`, from a release-please package declared at the repository root (`.`), and keep `always-update` off, the default. With it on, release-please refreshes the PR on every push and every merge would publish `next`.

   | The package.json is at | In `release-please-config.json`, on the `.` package                                                 |
   | ---------------------- | --------------------------------------------------------------------------------------------------- |
   | the repository root    | `"release-type": "node"`, or the row below with `"path": "package.json"`                            |
   | `packages/cli`         | `"extra-files": [{ "type": "json", "path": "packages/cli/package.json", "jsonpath": "$.version" }]` |

   The starter's `"release-type": "simple"` leaves `package.json` alone on its own. With the `extra-files` entry it bumps the version and nothing else npm-specific, which is all this module needs.

   **Never declare the release-please package on the subfolder.** release-please then reports its outputs under that path (`packages/cli--release_created`), which the fleet's release leg does not read: `npm-latest` never runs, and the release stays a draft.

3. **Fill in the build hook** the sync seeds, `.github/actions/npm-build/action.yml` ([below](#the-hook-githubactionsnpm-buildactionyml)). The seed fails on purpose.

4. **Publish the package once by hand,** so it exists on npm: a trusted publisher is configured on an existing package. Publish the version on main or a lower one: `next` refuses a commit whose `package.json` is below a release on the registry.

5. **Add the trusted publisher** on npmjs.com, in the package's settings:

   | Field             | Value                                                                       |
   | ----------------- | --------------------------------------------------------------------------- |
   | Publisher         | GitHub Actions                                                              |
   | Repository        | this repository                                                             |
   | Workflow filename | `ci.yml` (npm reads the calling workflow, not the fleet's)                  |
   | Environment       | none                                                                        |
   | Allowed actions   | tick "npm publish" and "Allow npm dist-tag": a new publisher allows neither |

No token is stored anywhere: npm checks the run's OIDC token against that publisher. A fork runs neither leg.

### The pull request that adds the module

```text
PR adds npm to modules  -> validate-managed-files is red: the hook starter is not on the branch yet
add repo-platform:sync  -> the sync commits the hook starter and the manifest stamp onto the branch
                        -> the CI and PR Title runs of that commit show action_required: approve them, or push a commit
   or "NOT pushed"      -> the sync also changes a workflow file (a ci.yml that is behind): see the table below
a sync lands on main    -> the PR conflicts on .github/repo-platform-manifest.json: merge main, then add the label again
merge it as feat: ...   -> the release PR refreshes, and the first `next` publishes
```

- **The red check and the held runs** are every module change's, owned by [a module change on a pull request](../platform/sync/operator.md#a-module-change-on-a-pull-request): GitHub holds the runs of a commit the repository token pushed.
- **The label delivers this module only while every managed workflow is up to date.** The module's own file is the hook, an action. The label's sync commits its whole diff or nothing, with the repository token, which cannot write under `.github/workflows/`:

  | The sync's diff holds                          | The label                                        | Then                                                                                                                         |
  | ---------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
  | the hook and the manifest stamp                | pushes one commit                                | approve the held runs                                                                                                        |
  | a workflow file too, a `ci.yml` that is behind | commits nothing; its comment names each workflow | merge the repository's open sync PR, merge main, and add the label again; or the platform's owner dispatches the sync, below |

  ```bash
  gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=<owner>/<name> -f branch=<branch>
  ```

- **A `ci.yml` whose `npm-next` job passes no `release-branch`** is from before `next` read the release PR: the second row above. Until it is updated, an `npm-next` run that gets as far as reading that branch fails, naming the sync PR to merge.
- **A check that refuses the registration instead,** with `module "npm" is not a module files.yml offers` or `Unrecognized key: "npm"`, means the build this repository's manifest records is older than the module. Either route in the second row moves it: both sync at `stable` and restamp the manifest.
- **The conflict can return when a sync with a different build lands on main** while the PR is open: both sides restamp the manifest, and identical stamps merge cleanly. Keep the PR short-lived.
- **The title needs a type release-please puts in the changelog,** `feat` or `fix`. Under `chore` the release PR does not refresh, so nothing publishes to `next` until a later commit refreshes it.

## What the job does

```text
checkout -> plan -> build hook -> publish
            |         |             |
            |         |             reads the record again, publishes, checks the dist-tags
            |         builds with the version already in package.json
            reads the record, decides, and on next stamps the version
```

- **The plan** reads the package's record from the registry, fresh, and on `next` the version on the release PR's branch. Nothing to publish skips the hook, with a notice saying why: on `next` the job ends there, green, and at a release it goes on to move `next`.
- **The publish** reads the record again, since another run may have published meanwhile. After `npm publish` it reads the record until the version shows ([how long](#how-long-the-job-waits-for-the-registry)), then checks that the channel's dist-tag is not behind it.
- **One lane:** both channels share the concurrency lane `npm-publish`, so one publish at a time judges and lands.

## The hook: `.github/actions/npm-build/action.yml`

The hook is a starter: the sync writes it once when the module is selected and never rewrites it. It is a composite action, run from the checkout inside the publish job.

| Contract        | Value                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------- |
| input `version` | the version being published, already written into `package.json`                                |
| runs as         | a step of the publish job, on the checked-out judged commit, with full history, Node 24 on PATH |
| token           | the job's: contents read and id-token write, so it runs only code from the judged commit        |
| leaves          | the package directory ready for `npm publish`, its `package.json` version untouched             |
| runs when       | there is something to publish; a skipped publish builds nothing                                 |

The hook builds after the version is stamped, so a build that bakes the version in reads the right one.

**A package with `workspace:*` dependencies** must have them rewritten to real versions by the hook: `npm publish` uploads the manifest as it stands, and the fleet rewrites nothing. A bun repository, building and then checking what it built:

```yaml
inputs:
  version:
    description: The version being published
    required: true

runs:
  using: composite
  steps:
    - uses: oven-sh/setup-bun@<sha> # <tag>, the pin the bun starters carry
    - shell: bash
      run: bun install --frozen-lockfile
    - shell: bash
      run: bun run build
    - shell: bash
      env:
        VERSION: ${{ inputs.version }}
      run: test "$(node dist/cli.js --version)" = "$VERSION"
```

## The version on `next`

```text
1.3.0-main.57.20261114.g3f9c2ab
  |        |     |        |
  |        |     |        the commit's short sha, behind a g so an all-digit sha stays an identifier
  |        |     the commit's committer date, UTC
  |        the commits on main's first-parent line up to this one
  the version the open release PR will cut
```

The base is read from the release PR's branch: the version release-please wrote into this `package.json` there.

| `package.json` on main | The release PR will cut                     | `next`             |
| ---------------------- | ------------------------------------------- | ------------------ |
| `1.2.0`                | `1.2.1`, a fix                              | `1.2.1-main.57...` |
| `1.2.0`                | `1.3.0`, a feature                          | `1.3.0-main.57...` |
| `0.0.0`                | `0.1.0`, release-please's `initial-version` | `0.1.0-main.57...` |

It sorts below the release it leads to, above every earlier release, and above every earlier `-main.<count>...` version of the same release by the count. The version on disk must be a plain `X.Y.Z` on both channels, and so must the release PR's, above the one on disk.

**When the release PR's version drops** (a reverted feature turns `1.3.0` back into `1.2.1`), the lower pre-releases are skipped with a notice, and `next` stays on the last `1.3.0-main...` build until a version passes it. To move it sooner, run `npm dist-tag add <name>@<version> next` by hand.

**A repository that already publishes `next`** must have its live `next` below the first version this module mints: the same scheme with a lower count is, and anything higher makes the first run skip as behind.

## What the publish refuses

Before the publish, judged in the plan and again in the publish step, the first row that matches:

| The record shows                                            | Channel  | Outcome                                                        |
| ----------------------------------------------------------- | -------- | -------------------------------------------------------------- |
| the version already published, its channel's tag behind it  | both     | fails: a rerun of a publish that left the tag behind stays red |
| the version already published                               | both     | skipped with a notice, green: a rerun                          |
| a release above the version in this commit's `package.json` | `next`   | fails, in the plan: the commit predates that release           |
| a release at or above this version                          | `next`   | fails: the `package.json` on main is behind the registry       |
| a release at or above this version                          | `latest` | fails before any publish: a release never moves `latest` back  |
| `next` at or above this version                             | `next`   | skipped with a notice, green: `next` never moves back          |
| `next` on the build of this commit or a later one on main   | `next`   | skipped with a notice, green: `next` never moves back          |
| no such package, or anything the job cannot read            | both     | fails: it never publishes blind                                |
| anything else                                               | both     | publishes                                                      |

After the publish:

| The record shows                                                               | Outcome                                                                      |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| the version, and the channel's tag at or above it                              | green                                                                        |
| the version, and the channel's tag behind it                                   | fails: the publish landed under the wrong tag, or something moved the tag    |
| never the version, within [the wait](#how-long-the-job-waits-for-the-registry) | fails, with npm's error line when npm failed; a rerun finds what did land    |
| at a release, `next` missing or below the release                              | `npm dist-tag add` moves `next` to the release, then the record must show it |
| at a release, `next` at or above the release                                   | left there, with a notice                                                    |
| a release `latest` no longer names (a rerun a newer release overtook)          | `next` left there, with a notice naming the current release                  |

- **The manifest is refused** when it is `private: true`, or sets `tag`, `publishConfig.tag`, or a registry in `publishConfig`.
- **npm's own configuration is refused** when its `tag` is not npm's default, or it names another registry for the package, in an `.npmrc` or a variable, checked in the plan and again after the build hook, before the publish. Trusted publishing is registry.npmjs.org's alone, so that is the one registry this module reads and publishes to.
- **The package directory is npm's whole project:** every npm command runs with `--no-workspaces`, so an `.npmrc` at a workspace root above the package is not read.
- **The release tag must end with `v<version>`.** A mismatch means release-please did not bump this `package.json` (step 2).
- **The release PR's branch must show this `package.json`** at a plain `X.Y.Z` above the one on main, or `next` mints nothing. A PR that never changes the file means the same as the mismatched tag (step 2).
- **A release PR that proposes the version main already holds** (main at `1.0.0`, a first release PR for `1.0.0`) needs main's version lowered, never below the registry's newest release, or the PR's raised with release-please's `initial-version`.
- **A commit from before a release that has not published yet publishes nothing to `next`,** whatever the release PR's branch says by the time its job runs or is rerun. Its `package.json` is below the registry's newest release, which fails the plan. So does a `package.json` on main that is behind the registry.
- **A `ci.yml` that passes no `release-branch`** fails `npm-next` on a commit that has not published yet, naming the sync PR to merge. A rerun of a commit that already published reads no branch: it judges the version on the registry as [the first two rows above](#what-the-publish-refuses) do.
- **A commit publishes one version,** once the registry shows it. A rerun finds the version its commit already published by the `main.<count>.<date>.g<sha7>` ending and judges that one, also after the release PR changed its version or merged.
- **A failed write** is judged by the record, never by npm's message: the version being there counts as published. Otherwise the job fails with npm's error line and what to check on the trusted publisher.

## How long the job waits for the registry

```text
npm notice Your package is being processed and may take a few minutes to become available.
```

npm prints that after every publish: the registry accepts the upload, then shows the version only once it has processed it. The job reads the record every five seconds, each read a cache miss, for as long as npm's own answer earns:

| npm said            | The job waits up to | Then                                                                   |
| ------------------- | ------------------- | ---------------------------------------------------------------------- |
| the write succeeded | ten minutes         | fails: "re-run the job"                                                |
| the write failed    | two minutes         | fails with npm's error line, since a longer wait only delays the error |

The same two waits apply to the `next` tag a release moves.

**A rerun after the wait ran out** publishes nothing twice. Once the registry shows the version, the plan judges it as [the first two rows above](#what-the-publish-refuses) do: with its tag in place, it skips the build and the publish, green. Before that, the rerun publishes again, and whatever npm answers, the job passes when the version shows within the wait.

## Reruns and failures

- **A failed `npm-latest` leaves the GitHub release a draft:** `publish-release` waits for it. "Re-run failed jobs" finishes both: a version that did land is skipped, and `next` is still moved.
- **A rerun of a release that a newer one overtook** moves nothing: only the release `latest` names moves `next`, and the notice says which release is current.
- **Two merges close together** can leave the newer build off `next`. release-please reads main's tip, so the older commit's run can refresh the release PR with both commits in it and publish its own build. The newer commit's run then finds the PR up to date and publishes nothing. The next refresh publishes a build that holds both commits, and nothing is lost at the release.
- **"Re-run all jobs"** on a run that already refreshed the release PR finds it up to date too, and skips `npm-next`. Use "Re-run failed jobs", which keeps the release leg's answer.
- **A burst of merges** can cancel a pending npm leg: a lane keeps one waiting job. "Re-run failed jobs" on that run finishes it, and the release stays a draft until `npm-latest` succeeds. A rerun that a newer version overtook does not publish: `next` skips as behind a newer `next` or a later commit's build, and either channel fails as below a newer release.
- **A publish the registry shows only after the ten-minute wait** can leave `next` on an older build. That run fails and frees the lane, and an older commit's waiting run, reading a record without the newer version, publishes and takes `next`. The newer run's rerun then stays red, its version on the registry with `next` behind it. Run `npm dist-tag add <name>@<the newer version> next` by hand, then rerun it.
- **A release merged while `npm-next` is red for a release PR at main's own version** lets a rerun of an earlier commit publish over that release: its `package.json` already holds the released version, so nothing marks it as older. Fix what the red message names before merging the release PR.
- **Removing the module** skips both legs; the hook stays (a starter), and the package stays on npm.

## Private repositories

Publishing works the same. npm attaches provenance only for a public repository publishing a public package, so a private repository's package carries none. A package that is itself private on npm is not supported: the job reads the record without a token.
