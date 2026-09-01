# repo-platform documentation

repo-platform manages standards files, CI workflows, and repository settings across Vivswan's repositories from one place: a Copier template renders each repo's files, push-based sync PRs keep them current, and reusable workflows run the fleet's CI. Code is the source of truth, so each page links to the file that owns a behavior instead of restating it.

## I want to...

| Goal | Read |
|---|---|
| Create a new managed repository | [New repo](new-repo.md) |
| Find out why my PR is pending or red | [All-green](all-green.md) |
| Change a repository's settings or labels | [Settings](settings.md) |
| Publish a site to GitHub Pages | [Pages](pages.md) |
| Serve a Pages site from my own domain | [Pages: custom domain](pages.md#custom-domain) |
| Write the fuzz step the nightly-fuzz starter needs | [Fuzzer: customizing the starter](fuzzer.md#customizing-the-starter) |
| Move slow or flaky checks into a nightly run | [Nightly: customizing the starter](nightly.md#customizing-the-starter) |
| Understand the issue a red night filed | [Tracking issues: lifecycle](tracking-issues.md#issue-lifecycle) |
| Ship a release while a tracking issue is open | [Tracking issues: release gating](tracking-issues.md#release-gating) |
| Rename a tracking label without breaking the stream | [Tracking issues: renaming the label](tracking-issues.md#renaming-the-label) |
| Host agent skills other repos can install | [Skills](skills.md) |
| Fix a skill that validates green but never ships | [Skills: publishing](skills.md#publishing-a-skill) |
| See which toolchain versions the fleet pins | [Toolchains: the pins](toolchains.md#the-pins) |
| Use a different toolchain version in one repo | [Toolchains: overriding](toolchains.md#overriding-per-toolchain) |
| Review a template change's rendered diff | [Golden renders](golden-renders.md) |
| Check why the `build` branch can be trusted | [Build provenance](build-provenance.md) |
| Keep a private repo's name out of fleet logs | [Private repos](private-repos.md) |
| Stop sync PRs without detaching | [Eject: pause](eject.md#pause-instead-of-eject) |
| Detach a repository from management | [Eject](eject.md) |

## The pages

### Using the fleet

1. [New repo](new-repo.md) - scaffold a repository, render the template, and register it with the fleet.
2. [Settings](settings.md) - the six-layer settings merge and how applies run.
3. [All-green](all-green.md) - the required check: ci.yml's own gate job judging every needed result.
4. [Private repos](private-repos.md) - what fleet logs hide for private repositories, and how to see the full detail.

### Modules

5. [Pages](pages.md) - the managed GitHub Pages deploy: production from releases, staging from main.
6. [Skills](skills.md) - hosting agent skills with fleet-managed validation.
7. [Fuzzer](fuzzer.md) - the nightly fuzz starter and its failure-report contract.
8. [Nightly](nightly.md) - a nightly CI stream for checks too slow for every PR.
9. [Tracking issues](tracking-issues.md) - the issue stream the fuzzer and nightly modules share: lifecycle, release gating, renaming.
10. [Toolchains](toolchains.md) - the fleet-wide toolchain version pins and how to override one.

### Platform internals

11. [Golden renders](golden-renders.md) - committed render snapshots of a canonical module matrix, showing a template change's rendered diff.
12. [Build provenance](build-provenance.md) - why the `build` delivery branch is trustworthy, and what residual trust remains.

### Leaving

13. [Eject](eject.md) - pausing sync PRs, or detaching a repository entirely.
