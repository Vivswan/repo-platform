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
- [Python](modules/python.md): the lint floor every Python repository's managed ruff.toml carries and fleet CI's ruff step enforces.
- [TypeScript](modules/typescript.md): the managed `biome.json` lint floor every bun repository carries, the repo-owned layer under it, and the `biome` and `member-shape` gates.
- [Tracking issues](modules/tracking-issues.md): the issue stream the fuzzer, nightly, site, and security streams share: lifecycle and release gating.
- [Security scans](modules/security-scans.md): Trivy fleet-wide (the blocking gate, the expiring bypass file, the nightly scan's tracking issues) and semgrep on public repositories.

### Understand the platform (`docs/platform/`)

- [Build provenance](platform/build-provenance.md): why the `stable` delivery tag is trustworthy, and what residual trust remains.
- [The post-green run](platform/post-green.md): repo-platform's own legs after the gate: the tag mover, the fleet sync and settings calls, how the fleet-sync label is read, the default label, and the gate's residuals.
- [The settings apply](platform/settings-apply.md): the central run that applies every rendered `.github/settings.yml`: its green-commit gate, newest wins, selection, private targets, check mode, and the token.
- [The file list](platform/sync/files.md): what may `files.yml` say, and which entries apply to one repository: the grammar, module data, what the loader refuses, upstream refs, placeholders, selection.
- [The writer](platform/sync/writer.md): how each class is written, what holds the PR, and how a file leaves: the command, classes, class flips, retirement, migrations, the report, the code behind each rule.
- [Mirrors](platform/sync/mirrors.md): how a written file is carried to more paths: what fleet CI's `plan` step refuses on the PR, what the writer refuses or reports.
- [The manifest](platform/sync/manifest.md): what the manifest records, and at which commit a repository is judged: the records, when the judged commit moves, the managed files check.
- [The operator](platform/sync/operator.md): how the fleet run reaches a repository, a branch, or a labeled pull request: the row jobs, delivery, the branch dispatch, the label, this repository as a target of itself.
- [Private repositories](platform/sync/private-repositories.md): what stays out of the public log for a private repository: the four rules, what a run still shows, where the model stops.
