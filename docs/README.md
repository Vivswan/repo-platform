# repo-platform

repo-platform manages standards files, CI workflows, and repository settings across Vivswan's repositories from one place: a Copier template renders each repo's files, push-based sync PRs keep them current, and reusable workflows run the fleet's CI. Code is the source of truth, so each page links to the file that owns a behavior instead of restating it.

## I want to...

| Goal | Read |
|---|---|
| Create a new managed repository | [New repo](new-repo.md) |
| Read a `validate-template` result: what blocks, what only warns | [New repo: the template check](new-repo.md#the-template-check) |
| Get a PR auto-formatted, or make bot fix commits re-run CI | [New repo: fix commits](new-repo.md#fix-commits-and-re-triggering-ci) |
| Add or remove a module, and get its render onto the same PR | [New repo: changing the module selection](new-repo.md#changing-the-module-selection) |
| Ship a release, or verify a release asset's provenance | [New repo: the release pipeline](new-repo.md#the-release-pipeline-release-please) |
| Know which conventions every managed repo follows, and what enforces each | [Fleet guidelines](fleet-guidelines.md) |
| Find out why my PR is pending or red | [All-green: quick triage](all-green.md#quick-triage-why-is-my-pr-red-or-waiting) |
| Change a repository's settings or labels | [Settings](settings.md) |
| Understand the `pr-title` required check | [Settings: the pr-title ruleset](settings.md#the-pr-title-ruleset) |
| Publish a site to GitHub Pages | [Pages](pages.md) |
| Serve a Pages site from my own domain | [Pages: custom domain](pages.md#custom-domain) |
| Publish my repo's docs/ as a website | [Docs site](docs-site.md) |
| Translate docs (zh-cn/, ja/, ...) | [Docs site: content conventions](docs-site.md#content-conventions) |
| Host agent skills other repos can install | [Skills](skills.md) |
| Fix a skill that validates green but never ships | [Skills: publishing](skills.md#publishing-a-skill) |
| Move slow or flaky checks into a nightly run | [Nightly: customizing the starter](nightly.md#customizing-the-starter) |
| Write the fuzz step the nightly-fuzz starter needs | [Fuzzer: customizing the starter](fuzzer.md#customizing-the-starter) |
| See which toolchain versions the fleet pins | [Toolchains: the pins](toolchains.md#the-pins) |
| Use a different toolchain version in one repo | [Toolchains: overriding](toolchains.md#overriding-per-toolchain) |
| Understand the issue a red night filed | [Tracking issues: lifecycle](tracking-issues.md#issue-lifecycle) |
| Ship a release while a tracking issue is open | [Tracking issues: release gating](tracking-issues.md#release-gating) |
| Rename a tracking label without breaking the stream | [Tracking issues: renaming the label](tracking-issues.md#renaming-the-label) |
| Move or rewrite a rendered file across the fleet (a one-shot transition) | [Migrations: adding a rung](migrations.md#adding-a-rung) |
| Find out why a sync PR moved a file before the copier diff | [Migrations: the walk](migrations.md#the-walk-over-build-history) |
| Add a module file, fragment, or anchor to the template | [Composition](compose.md) |
| Review a template change's rendered diff | [Golden renders](golden-renders.md) |
| Check why the `build` branch can be trusted | [Build provenance](build-provenance.md) |
| Keep a private repo's name out of fleet logs | [Private repos](private-repos.md) |
| Find where a private repo's failure details land | [Private repos: seeing the full detail](private-repos.md#seeing-the-full-detail) |
| Stop sync PRs without detaching | [Eject: pause](eject.md#pause-instead-of-eject) |
| Detach a repository from management | [Eject](eject.md) |

## The pages

### Start here

1. [New repo](new-repo.md) - scaffold a repository, render the template, and register it with the fleet.
2. [Fleet guidelines](fleet-guidelines.md) - the conventions every managed repository follows, each with what enforces it.
3. [All-green](all-green.md) - the required check: ci.yml's own gate job judging every needed result.
4. [Settings](settings.md) - the settings layer stack, the merge the action owns, and how applies run.

### Modules

5. [Pages](pages.md) - the managed GitHub Pages deploy: a versioned site of the repo's own build (root = newest served tag, latest/ = main).
6. [Docs site](docs-site.md) - the repo's docs/ markdown as a versioned VitePress site under the central fleet theme.
7. [Skills](skills.md) - hosting agent skills with fleet-managed validation.
8. [Nightly](nightly.md) - a nightly CI stream for checks too slow for every PR.
9. [Fuzzer](fuzzer.md) - the nightly fuzz starter and its failure-report contract.

### Fleet operations

10. [Toolchain pins](toolchains.md) - the fleet-wide toolchain version pins and how to override one.
11. [Tracking issues](tracking-issues.md) - the issue stream the fuzzer, nightly, and docs-site modules share: lifecycle, release gating, renaming.
12. [Migrations](migrations.md) - the ladder of one-shot fleet transitions: one self-contained file per rung on the build branch, and the sync's walk over build history that runs the rungs a repository has not crossed.
13. [Composition](compose.md) - how templates/ composes into the tree copier renders: gates, anchors, fragments, data anchors, collisions, and the ownership contract.
14. [Golden renders](golden-renders.md) - committed render snapshots of a canonical module matrix, showing a template change's rendered diff.
15. [Build provenance](build-provenance.md) - why the `build` delivery branch is trustworthy, and what residual trust remains.
16. [Private repos](private-repos.md) - what fleet logs hide for private repositories, and how to see the full detail.
17. [Eject](eject.md) - pausing sync PRs, or detaching a repository entirely.
