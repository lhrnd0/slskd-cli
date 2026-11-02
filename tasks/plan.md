# First public CLI preview

## Release scope

Ship the current agent-first CLI through npm.
The package name is `slskd-cli`; the executable is `slskd`.
The first preview source tag is `v0.1.0-beta.1`; its intended npm distribution tag is `next`.
Registry publication remains pending.
The preview includes Search, Candidate, folder, Transfer, and Private message commands.
Changes enter `main` through a PR with passing CI and approval.
After merge and successful `main` CI, the tag job creates a missing version tag at the verified commit.
Existing matching tags stay unchanged; release PRs use a new package version.
Publication follows that tag as a future step.
Keep the current JSON envelopes, exit codes, and explicit mutation acknowledgement.
Do not add features or unrelated refactors to this release.

Tasks live in Beads under `slskd-cli-4a9`.
This document records release decisions and evidence; Beads holds task status and dependencies.

## Historical baseline before release preparation

The planning session started on 2026-11-01 in America/Sao_Paulo.
The inspected source commit is `2fb46ed`.
The working tree was clean before planning.
At that commit, the package declared version `0.1.0`, Node.js `>=24`, and pnpm `12.14.0`.
Lint, formatting, type checking, build, and all 80 tests passed.
No tracked release workflow, license, changelog, or Git tags were found.
Package metadata lacked license, repository, bugs, and homepage fields.
The public registry returned `E404` for `slskd-cli`; publisher access and name eligibility remain unverified.
The shell's configured registry, `https://npm.apple.com`, failed DNS resolution.
Release checks must target the intended public registry explicitly.
The existing live-message issue recorded connection failure and timeout against the configured slskd instance.

## Ordered work

| Order | Beads issue     | Release requirement                                                                        |
| ----- | --------------- | ------------------------------------------------------------------------------------------ |
| 1     | `slskd-cli-82i` | Reject a mismatched Transfer username before inspection or mutation.                       |
| 2     | `slskd-cli-307` | Report `existing:true` after a reconciled concurrent enqueue conflict.                     |
| 3     | `slskd-cli-dsg` | Confirm package ownership, choose a license, and verify clean tarball installation.        |
| 4     | `slskd-cli-8s1` | Automate quality gates and package installation checks in CI.                              |
| 5     | `slskd-cli-jgo` | Verify the Search-to-Transfer Workflow against live slskd.                                 |
| 5     | `slskd-cli-mdp` | Verify Private messages against live slskd with a known test recipient.                    |
| 6     | `slskd-cli-ttv` | Prepare release notes, obtain publication authorization, and verify the published package. |

Live validation must use the fixed release candidate.
Publication depends on package checks, CI, live Workflow evidence, and live message evidence.
Each task includes acceptance criteria and verification details in Beads.

## Verification and checkpoints

After both bug fixes, run the packaged CLI tests and all repository quality gates.
After packaging, install the tarball in a clean temporary prefix without development dependencies.
Run the installed executable's offline help and a fixture-backed `check`.
Inspect package contents for runtime imports, README, license, and accidental credential or development files.
Audit production dependencies and assess any high or critical findings before release.
CI validates Linux and macOS. Windows support remains unverified.

Live checks start with slskd `0.26.1` and record the exact tested daemon version.
The current README claims support for `0.26.1` or later.
Test a newer daemon version before retaining that broad statement, or state the measured support limits.
Use test-owned Searches and Transfers for state-changing checks.
Use a known test recipient for Private message sending and acknowledgement checks.
Record JSON output and exit codes with credentials removed.
Do not use a global Transfer clear against an instance containing unrelated downloads.

## Delivery and recovery

Freeze the tagged `main` commit, package version, tarball checksum, and release notes before publication.
Confirm npm publisher access and package name availability before finalizing installation instructions.
Document the first-publication authentication path before configuring automated publication.
Prefer trusted publishing when the account and repository setup support it.
Changes enter `main` through approved PRs.
The owner approved automatic version tags after successful `main` CI.
Publication and Dolt remote synchronization still require explicit authorization.

After publication, install the exact registry version in a clean environment.
Verify help, configuration, and `check` through the installed `slskd` executable.
Confirm that the Git tag, npm version, release notes, and source commit agree.
Observe installation failures and reported Workflow failures during the first 48 hours.
Use issue reports and reproducible commands; automatic telemetry is outside this release scope.

If the preview leaks credentials or mutates the wrong target, stop promotion immediately.
Deprecate the defective preview and publish a corrected prerelease after verification.
Move `next` to a verified version when one exists.
The first public preview has no previous published version to restore.
Never cancel successful Transfers as release recovery.

## Decisions still needed

The owner selected MIT. The npm publisher identity still needs confirmation.
The source tag `v0.1.0-beta.1` exists; the intended npm preview tag is `next`.
Read-only checks passed against the reachable slskd `0.26.1.0` instance.
The owner postponed live download and message mutation checks.
Those checks still require test-owned download data and a known message recipient.
Do not close `slskd-cli-whx` solely because folder commands exist.
Compare its acceptance criteria with implementation and test evidence before changing its status.
The cleanup issues `slskd-cli-0ez` and `slskd-cli-cpn` remain outside the preview blockers.

## References

- [npm distribution tags](https://docs.npmjs.com/adding-dist-tags-to-packages/)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [Distribution decision](../docs/adr/0002-node-typescript-npm-distribution.md)

Use an explicit distribution tag for preview publication.
npm otherwise assigns the `latest` tag by default.
