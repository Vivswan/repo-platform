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

After `1.2.0`, commits A and B change nothing a release would carry, so release-please leaves its PR alone and npm gets nothing. C is a fix: the release PR refreshes, and C's build goes to `next`. Merging the release PR publishes `1.2.1` to `latest` and moves `next` to it.

| Channel  | Publishes when                                                                 | Version                                 | Install                   |
| -------- | ------------------------------------------------------------------------------ | --------------------------------------- | ------------------------- |
| `latest` | release-please cuts a release                                                  | the one release-please wrote, `X.Y.Z`   | `npm install <name>`      |
| `next`   | a push to main creates or refreshes the release PR (`prs_created`), never else | `X.Y.(Z+1)-main.<count>.<date>.g<sha7>` | `npm install <name>@next` |

**`next` is never older than `latest`:** a release moves `next` to itself, and each release-PR refresh after it moves `next` on.

## Set it up

1. **Select the module** with `release-please`, in `.repo-platform.yml`:

   ```yaml
   modules: [bun, release-please, npm]
   npm:
     path: packages/cli # only when package.json is not at the repository root
   ```

2. **Let release-please write the version** into that `package.json`: give the package `"release-type": "node"` in `release-please-config.json` (the starter's `simple` leaves `package.json` alone), and keep `always-update` off, the default. With it on, release-please refreshes the PR on every push and every merge would publish `next`.

3. **Fill in the build hook** the sync seeds, `.github/actions/npm-build/action.yml` ([below](#the-hook-githubactionsnpm-buildactionyml)). The seed fails on purpose.

4. **Publish the package once by hand,** so it exists on npm: a trusted publisher is configured on an existing package.

5. **Add the trusted publisher** on npmjs.com, in the package's settings:

   | Field             | Value                                                                       |
   | ----------------- | --------------------------------------------------------------------------- |
   | Publisher         | GitHub Actions                                                              |
   | Repository        | this repository                                                             |
   | Workflow filename | `ci.yml` (npm reads the calling workflow, not the fleet's)                  |
   | Environment       | none                                                                        |
   | Allowed actions   | tick "npm publish" and "Allow npm dist-tag": a new publisher allows neither |

No token is stored anywhere: npm checks the run's OIDC token against that publisher. A fork runs neither leg.

## What the job does

```text
checkout -> plan -> build hook -> publish
            |         |             |
            |         |             reads the record again, publishes, checks the dist-tags
            |         builds with the version already in package.json
            reads the record, decides, and on next stamps the version
```

- **The plan** reads the package's record from the registry, fresh. Nothing to publish skips the hook, with a notice saying why: on `next` the job ends there, green, and at a release it goes on to move `next`.
- **The publish** reads the record again, since another run may have published meanwhile. After `npm publish` it reads the record until the version shows, then checks that the channel's dist-tag is not behind it.
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

The hook builds after the version is stamped, so a build that bakes the version in reads the right one. A bun repository, building and then checking what it built:

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
      env: { VERSION: "${{ inputs.version }}" }
      run: test "$(node dist/cli.js --version)" = "$VERSION"
```

## The version on `next`

```text
1.2.1-main.57.20261114.g3f9c2ab
  |        |     |        |
  |        |     |        the commit's short sha, behind a g so an all-digit sha stays an identifier
  |        |     the commit's committer date, UTC
  |        the commits on main's first-parent line up to this one
  the next patch after the version on disk
```

It sorts above the last release, below the next one whatever its bump, and above every earlier `-main.<count>...` version of the same patch by the count. The version on disk must be a plain `X.Y.Z` on both channels.

**A repository that already publishes `next`** must have its live `next` below the first version this module mints: the same scheme with a lower count is, and anything higher makes the first run skip as behind.

## What the publish refuses

Before the publish, judged in the plan and again in the publish step:

| The record shows                                           | Channel  | Outcome                                                        |
| ---------------------------------------------------------- | -------- | -------------------------------------------------------------- |
| the version already published                              | both     | skipped with a notice, green: a rerun                          |
| the version already published, its channel's tag behind it | both     | fails: a rerun of a publish that left the tag behind stays red |
| `next` at or above this version                            | `next`   | skipped with a notice, green: `next` never moves back          |
| a release at or above this version                         | `next`   | fails: the `package.json` on main is behind the registry       |
| a release at or above this version                         | `latest` | fails before any publish: a release never moves `latest` back  |
| no such package, or anything the job cannot read           | both     | fails: it never publishes blind                                |
| anything else                                              | both     | publishes                                                      |

After the publish:

| The record shows                                  | Outcome                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| the version, and the channel's tag at or above it | green                                                                        |
| the version, and the channel's tag behind it      | fails: the publish landed under the wrong tag, or something moved the tag    |
| never the version, within two minutes             | fails, with npm's error line when npm failed; a rerun finds what did land    |
| at a release, `next` missing or below the release | `npm dist-tag add` moves `next` to the release, then the record must show it |
| at a release, `next` at or above the release      | left there, with a notice                                                    |

- **The manifest is refused** when it is `private: true`, or sets `publishConfig.tag`: the channel decides the dist-tag.
- **The release tag must end with `v<version>`.** A mismatch means release-please did not bump this `package.json` (step 2).
- **A failed write** is judged by the record, never by npm's message: the version being there counts as published. Otherwise the job fails with npm's error line and what to check on the trusted publisher.

## Reruns and failures

- **A failed `npm-latest` leaves the GitHub release a draft:** `publish-release` waits for it. "Re-run failed jobs" finishes both: a version that did land is skipped, and `next` is still moved.
- **A burst of merges** can cancel a pending npm leg: a lane keeps one waiting job. "Re-run failed jobs" on that run finishes it, and the release stays a draft until `npm-latest` succeeds. A rerun that a newer version overtook does not publish: `next` skips as behind, and a release fails as below the newer one.
- **Removing the module** skips both legs; the hook stays (a starter), and the package stays on npm.

## Private repositories

Publishing works the same. npm attaches provenance only for a public repository publishing a public package, so a private repository's package carries none. A package that is itself private on npm is not supported: the job reads the record without a token.
