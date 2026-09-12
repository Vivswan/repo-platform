# repo-platform

repo-platform manages standards files, CI workflows, and repository settings across Vivswan's repositories from one place: a writer copies each repo's files from one file list, push-based sync PRs keep them current, and reusable workflows run the fleet's CI. Code is the source of truth, so each page links to the file that owns a behavior instead of restating it.

## I want to...

| Goal | Read |
|---|---|
| Create a new managed repository | [New repo](new-repo.md) |
| Read a `validate-managed-files` result: what blocks, what only warns | [New repo: the managed files check](new-repo.md#the-managed-files-check) |
| Get a PR auto-formatted, or make bot fix commits re-run CI | [New repo: fix commits](new-repo.md#fix-commits-and-re-triggering-ci) |
| Add or remove a module, and get its files as the sync PR that follows | [New repo: changing the module selection](new-repo.md#changing-the-module-selection) |
| Ship a release, or verify a release asset's provenance | [New repo: the release pipeline](new-repo.md#the-release-pipeline-release-please) |
| Know which conventions every managed repo follows, and what enforces each | [Fleet guidelines](fleet-guidelines.md) |
| Find out why my PR is pending or red | [All-green: quick triage](all-green.md#quick-triage-why-is-my-pr-red-or-waiting) |
| Change a repository's settings or labels | [Settings](settings.md) |
| Understand the `pr-title` required check | [Settings: the pr-title ruleset](settings.md#the-pr-title-ruleset) |
| Publish a site to GitHub Pages: the repo's own website, its docs/, or both | [Site](site.md) |
| Fill in the site-build hook that builds my website | [Site: the hook](site.md#the-hook-githubactionssite-buildactionyml) |
| Serve the site from my own domain | [Site: custom domain](site.md#custom-domain) |
| Translate docs (zh-cn/, ja/, ...) | [Site: docs conventions](site.md#docs-conventions) |
| Move slow or flaky checks into a nightly run | [Nightly: customizing the starter](nightly.md#customizing-the-starter) |
| Write the fuzz step the nightly-fuzz starter needs | [Fuzzer: customizing the starter](fuzzer.md#customizing-the-starter) |
| See which toolchain versions the fleet pins | [Toolchains: the pins](toolchains.md#the-pins) |
| Use a different toolchain version in one repo | [Toolchains: overriding](toolchains.md#overriding-per-toolchain) |
| Silence a Trivy finding that blocks my PR, or read the nightly security issue | [Security scans](security-scans.md) |
| Mark a semgrep finding, or see which rules the fleet excludes | [Security scans: semgrep](security-scans.md#semgrep) |
| Understand the issue a red night filed | [Tracking issues: lifecycle](tracking-issues.md#issue-lifecycle) |
| Ship a release while a tracking issue is open | [Tracking issues: release gating](tracking-issues.md#release-gating) |
| Rename a tracking label without breaking the stream | [Tracking issues: renaming the label](tracking-issues.md#renaming-the-label) |
| Add, rename, or retire a file the platform writes | [Sync: files.yml](sync.md#filesyml) |
| Read a sync PR's report, or find why a row held | [Sync: the report](sync.md#the-report) |
| Check why the `build` branch can be trusted | [Build provenance](build-provenance.md) |
| Keep a private repo's name out of fleet logs, and find where its details land | [Sync: private repositories](sync.md#private-repositories) |
| Stop sync PRs without detaching | [Eject: pause](eject.md#pause-instead-of-eject) |
| Detach a repository from management | [Eject](eject.md) |

## The pages

### Start here

1. [New repo](new-repo.md) - scaffold a repository, register it with the fleet, and receive its first sync PR.
2. [Fleet guidelines](fleet-guidelines.md) - the conventions every managed repository follows, each with what enforces it.
3. [All-green](all-green.md) - the required check: ci.yml's own gate job judging every needed result.
4. [Settings](settings.md) - the six-layer settings merge and how applies run.

### Modules

5. [Site](site.md) - one GitHub Pages site per repository: the repo-owned site-build hook's website at the root, docs/ rendered under the central fleet theme.
6. [Nightly](nightly.md) - a nightly CI stream for checks too slow for every PR.
7. [Fuzzer](fuzzer.md) - the nightly fuzz starter and its failure-report contract.

### Fleet operations

8. [Sync](sync.md) - the writer, its file list, the report, the operator that runs it against the fleet, and what the public log hides for private repositories.
9. [Toolchain pins](toolchains.md) - the fleet-wide toolchain version pins and how to override one.
10. [Tracking issues](tracking-issues.md) - the issue stream the fuzzer, nightly, site, and security streams share: lifecycle, release gating, renaming.
11. [Security scans](security-scans.md) - Trivy fleet-wide: the blocking gate (fixable HIGH-or-CRITICAL vulnerabilities, any HIGH-or-CRITICAL misconfiguration), the expiring bypass file, and the nightly scan that files one tracking issue per repository; semgrep on public repositories.
12. [Build provenance](build-provenance.md) - why the `build` delivery branch is trustworthy, and what residual trust remains.
13. [Eject](eject.md) - pausing sync PRs, or detaching a repository entirely.
