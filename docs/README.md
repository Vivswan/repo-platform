# repo-platform

repo-platform manages standards files, CI workflows, and repository settings across Vivswan's repositories from one place: a writer copies each repo's files from one file list, push-based sync PRs keep them current, and reusable workflows run the fleet's CI. Code is the source of truth, so each page links to the file that owns a behavior instead of restating it.

## I want to...

| Goal | Read |
|---|---|
| Create a new managed repository | [New repo](new-repo.md) |
| Read a `validate-managed-files` result: what blocks, what is not judged | [New repo: the managed files check](new-repo.md#the-managed-files-check) |
| Get a PR auto-formatted, or make bot fix commits re-run CI | [New repo: fix commits](new-repo.md#fix-commits-and-re-triggering-ci) |
| Add or remove a module, and get its files as the sync PR that follows | [New repo: changing the module selection](new-repo.md#changing-the-module-selection) |
| Ship a release, or verify a release asset's provenance | [New repo: the release pipeline](new-repo.md#the-release-pipeline-release-please) |
| Know which conventions every managed repo follows, and what enforces each | [Fleet guidelines](fleet-guidelines.md) |
| Find out why my PR is pending or red | [All-green: quick triage](all-green.md#quick-triage-why-is-my-pr-red-or-waiting) |
| Change a repository's settings or labels | [Settings](settings.md) |
| Understand the `pr-title` required check | [Settings: the pr-title ruleset](settings.md#the-pr-title-ruleset) |
| Publish a site to GitHub Pages: the repo's own website, its docs/, or both | [Site](site.md) |
| Fill in the site-build hook that builds my website | [Site: the hook](site.md#the-hook-githubactionssite-buildactionyml) |
| Translate docs (zh-cn/, ja/, ...) | [Site: docs conventions](site.md#docs-conventions) |
| Move slow or flaky checks into a nightly run | [Nightly: customizing the starter](nightly.md#customizing-the-starter) |
| Write the fuzz step the nightly-fuzz starter needs | [Fuzzer: customizing the starter](fuzzer.md#customizing-the-starter) |
| Adopt the Rust lint floor in a repository that already has a `Cargo.toml` | [Rust: how a repository takes it](rust.md#how-a-repository-takes-it) |
| See which toolchain versions the fleet pins | [Toolchains: the pins](toolchains.md#the-pins) |
| Use a different toolchain version in one repo | [Toolchains: overriding](toolchains.md#overriding-per-toolchain) |
| Silence a Trivy finding that blocks my PR, or read the nightly security issue | [Security scans](security-scans.md) |
| Mark a semgrep finding, or see which rules the fleet excludes | [Security scans: semgrep](security-scans.md#semgrep) |
| Understand the issue a red night filed | [Tracking issues: lifecycle](tracking-issues.md#issue-lifecycle) |
| Ship a release while a tracking issue is open | [Tracking issues: release gating](tracking-issues.md#release-gating) |
| Rename a tracking label without breaking the stream | [Tracking issues: renaming the label](tracking-issues.md#renaming-the-label) |
| Add or remove a file the platform writes | [The file list: files.yml](platform/sync/files.md#filesyml) |
| Read a sync PR's report, or find why a row held | [The writer: the report](platform/sync/writer.md#the-report) |
| Check why the `stable` tag can be trusted | [Build provenance](build-provenance.md) |
| Change a managed workflow so it uses a new input of a platform action | [Build provenance: a new action input and its workflow land together](build-provenance.md#a-new-action-input-and-its-workflow-land-together) |
| Keep a private repo's name out of fleet logs, and find where its details land | [Private repositories](platform/sync/private-repositories.md) |
| Stop sync PRs without detaching | [Eject: pause](eject.md#pause-instead-of-eject) |
| Detach a repository from management | [Eject](eject.md) |

## The pages

The groups below are the sidebar's, in its order.

### Start here

- [New repo](new-repo.md): scaffold a repository, register it with the fleet, and receive its first sync PR.
- [Fleet guidelines](fleet-guidelines.md): the conventions every managed repository follows, each with what enforces it.
- [All-green](all-green.md): the required check: ci.yml's own gate job judging every needed result.
- [Settings](settings.md): the six-layer settings merge and how applies run.

### Modules

- [Site](site.md): one GitHub Pages site per repository: the repo-owned site-build hook's website at the root, docs/ rendered under the central fleet theme.
- [Nightly](nightly.md): a nightly CI stream for checks too slow for every PR.
- [Fuzzer](fuzzer.md): the nightly fuzz starter and its failure-report contract.
- [Rust](rust.md): the `Cargo.toml` lint floor every Rust repository carries, and the cargo gate that enforces it.

### Fleet operations

- [Toolchain pins](toolchains.md): the fleet-wide toolchain version pins and how to override one.
- [Tracking issues](tracking-issues.md): the issue stream the fuzzer, nightly, site, and security streams share: lifecycle, release gating, renaming.
- [Security scans](security-scans.md): Trivy fleet-wide (the blocking gate, the expiring bypass file, the nightly scan's tracking issues) and semgrep on public repositories.
- [Build provenance](build-provenance.md): why the `stable` delivery tag is trustworthy, and what residual trust remains.
- [Eject](eject.md): pausing sync PRs, or detaching a repository entirely.

### Platform

- [Sync](platform/sync/README.md): the entry to the sync's contract: what the writer writes, where its code is, and this repository as a target of itself; one page per subject follows.
- [The file list](platform/sync/files.md): the grammar of `files.yml`: entries, module data, what the loader refuses, upstream refs, placeholders, selection.
- [The writer](platform/sync/writer.md): the command, how each class is written and what holds the PR, class flips, retirement, migrations, the report.
- [Mirrors](platform/sync/mirrors.md): a written file carried to more paths, and what each of its two readers refuses.
- [The manifest](platform/sync/manifest.md): the records, the stamp rule that moves the judged commit, and the managed files check that judges at it.
- [The operator](platform/sync/operator.md): the fleet run, one row job per repository: delivery, the branch dispatch, the `repo-platform:sync` label.
- [Private repositories](platform/sync/private-repositories.md): what the public log keeps out for a private repository, and where that model stops.
