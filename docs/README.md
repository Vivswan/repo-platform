# repo-platform

repo-platform manages standards files, CI workflows, and repository settings across Vivswan's repositories from one place: a writer copies each repo's files from one file list, push-based sync PRs keep them current, and reusable workflows run the fleet's CI. Code is the source of truth, so each page links to the file that owns a behavior instead of restating it.

## The pages

One list per folder, each in the sidebar's order.

### Run a repository on the fleet (`docs/`)

- [New repo](new-repo.md): scaffold a repository, register it with the fleet, and receive its first sync PR.
- [Fleet guidelines](fleet-guidelines.md): the conventions every managed repository follows, each with what enforces it.
- [All-green](all-green.md): the required check: ci.yml's own gate job judging every needed result, the post-green hook, and the fleet-sync label from the PR's side.
- [Settings](settings.md): the six-layer settings merge, the dialect, when the result is applied, and what the apply does to it.
- [Toolchain pins](toolchains.md): the fleet-wide toolchain version pins and how to override one.
- [Eject](eject.md): pausing sync PRs, or detaching a repository entirely.

### Pick a module (`docs/modules/`)

- [Site](modules/site.md): one GitHub Pages site per repository: the repo-owned site-build hook's website at the root, docs/ rendered under the central fleet theme.
- [Nightly](modules/nightly.md): a nightly CI stream for checks too slow for every PR.
- [Fuzzer](modules/fuzzer.md): the nightly fuzz starter and its failure-report contract.
- [Rust](modules/rust.md): the `Cargo.toml` lint floor every Rust repository carries, and the cargo gate that enforces it.
- [Tracking issues](modules/tracking-issues.md): the issue stream the fuzzer, nightly, site, and security streams share: lifecycle, release gating, renaming.
- [Security scans](modules/security-scans.md): Trivy fleet-wide (the blocking gate, the expiring bypass file, the nightly scan's tracking issues) and semgrep on public repositories.

### Understand the platform (`docs/platform/`)

- [Build provenance](platform/build-provenance.md): why the `stable` delivery tag is trustworthy, and what residual trust remains.
- [The post-green run](platform/post-green.md): repo-platform's own legs after the gate: the tag mover, the fleet sync and settings calls, how the fleet-sync label is read, the default label, and the gate's residuals.
- [The settings apply](platform/settings-apply.md): the central run that applies every rendered `.github/settings.yml`: its green-commit gate, newest wins, selection, private targets, check mode, and the token.
- [Sync](platform/sync/README.md): the entry to the sync's contract: what the writer writes, where its code is, and this repository as a target of itself; one page per subject follows.
- [The file list](platform/sync/files.md): the grammar of `files.yml`: entries, module data, what the loader refuses, upstream refs, placeholders, selection.
- [The writer](platform/sync/writer.md): the command, how each class is written and what holds the PR, class flips, retirement, migrations, the report.
- [Mirrors](platform/sync/mirrors.md): a written file carried to more paths, and what each of its two readers refuses.
- [The manifest](platform/sync/manifest.md): the records, the stamp rule that moves the judged commit, and the managed files check that judges at it.
- [The operator](platform/sync/operator.md): the fleet run, one row job per repository: delivery, the branch dispatch, the `repo-platform:sync` label.
- [Private repositories](platform/sync/private-repositories.md): what the public log keeps out for a private repository, and where that model stops.
