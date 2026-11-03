# repo-platform

repo-platform manages standards files, CI workflows, and repository settings across Vivswan's repositories from one place: a writer copies each repo's files from one file list, push-based sync PRs keep them current, and reusable workflows run the fleet's CI.

Code is the source of truth, so each page keeps what no check, action description, or data file says for itself, and links to the file that owns a behavior instead of restating it.

## The pages

- **Run a repository on the fleet** (`docs/`): [New repo](new-repo.md), [Fleet guidelines](fleet-guidelines.md), [All-green](all-green.md), [Settings](settings.md), [Toolchain pins](toolchains.md), [Eject](eject.md).
- **Pick a module** (`docs/modules/`): [Site](modules/site.md), [Nightly](modules/nightly.md), [Fuzzer](modules/fuzzer.md), [Rust](modules/rust.md), [Python](modules/python.md), [TypeScript](modules/typescript.md), [Tracking issues](modules/tracking-issues.md), [Security scans](modules/security-scans.md).
- **Understand the platform** (`docs/platform/`): [Build provenance](platform/build-provenance.md), [The post-green run](platform/post-green.md), [The settings apply](platform/settings-apply.md), and the sync's [file list](platform/sync/files.md), [writer](platform/sync/writer.md), [mirrors](platform/sync/mirrors.md), [manifest](platform/sync/manifest.md), [operator](platform/sync/operator.md), and [private repositories](platform/sync/private-repositories.md).
