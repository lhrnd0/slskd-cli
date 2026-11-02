# Release procedure

The first public preview candidate is `0.1.0-beta.1`.
Its npm distribution tag is `next`.
Release work and acceptance gates live in Beads epic `slskd-cli-4a9`.
This procedure does not authorize commits, tags, pushes, remote synchronization, or publication.

## Review and merge through a PR

All release changes enter `main` through a pull request.
Open the PR from the prepared branch with `main` as its base.
CI runs on PRs targeting `main` and on pushes to `main` after merge.
Both Linux and macOS checks must pass for the current PR revision.
Resolve review findings and obtain the required approval before merging.
Merge only when the PR is approved and ready.

Merging prepares `main` for release. It does not publish a package.
The release tag must point to a commit on `main`, after its CI checks pass.
Tag creation and publication are later steps with their own release gates.
Publishing automation is future work.

## Verify the candidate

Use the pnpm version declared in `package.json` and Node.js 24.
Run these commands from a clean checkout of the candidate commit:

```sh
pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org/
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm audit --prod --audit-level=high --registry=https://registry.npmjs.org/
pnpm package:check
```

CI runs these checks on Linux and macOS.
The package check also runs all CLI tests from the installed tarball, without source files or development dependencies.
A local pass does not establish that both CI jobs passed.
Successful CI jobs retain their exact verified tarballs for seven days.
For publication, download the tarball from successful CI for the tagged `main` commit.
Branch and PR tarballs provide review evidence; they are not the final publication candidate.
The `SLSKD_PACKAGE_ARTIFACT_DIR` environment variable also retains the verified tarball during a local package check.
Resolve high or critical production dependency advisories before publication.
Assess build and test dependency risks separately when dependencies change.

Record the exact CLI commit and slskd version for live validation.
Verify the Search-to-Transfer Workflow, folder selections, repeated enqueue, and wrong-username rejection.
Use test-owned data for cancellation and deletion.
Verify Private message sending and acknowledgement with a known test recipient.
Keep credentials and Private message text out of public evidence.
The live tasks remain open until their acceptance criteria pass.

## Confirm publication access

The owner must confirm the package name and publisher identity before publication.
An npm registry `E404` does not prove the name can be registered.
The owner selected MIT for this release.
Confirm that the release version and notes match the candidate artifact.

Use the public npm registry explicitly.
The planning environment's default registry failed DNS resolution at `npm.apple.com`.

Choose the first-publication authentication path with the package owner.
For subsequent automation, prefer [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) when supported.
Configure the repository and workflow identity exactly as npm requires.
Do not store long-lived publishing credentials in the repository or CI workflow.
The current CI workflow only verifies packages; it does not publish them.

## Tag main before publication

After all release blockers close, obtain explicit authorization for publication and Git release operations.
Select the approved commit on `main` after its CI checks pass.
Confirm that `package.json` and `CHANGELOG.md` describe `0.1.0-beta.1`.
Create `v0.1.0-beta.1` at that `main` commit and push the tag.
Use `CHANGELOG.md` for the release notes.

## Publish the tagged main commit — future step

Publication follows the release tag. It never publishes directly from the preparation branch or PR.
Before publication, verify that the tag points to a commit contained in `main`.
Verify that the successful `main` CI run and publication tarball match that tagged commit.
Keep the publication artifact outside the source checkout.
If the retained artifact expired, rebuild the tagged commit and repeat every candidate check before publication:

```sh
pnpm build
npm pack --ignore-scripts --pack-destination /absolute/path/to/release-artifacts
```

Record the tarball checksum and source commit in the release evidence.
Publish the reviewed artifact with an explicit preview tag:

```sh
npm publish /absolute/path/to/release-artifacts/slskd-cli-0.1.0-beta.1.tgz --tag next --access public --registry=https://registry.npmjs.org/
```

Remove the README's unpublished notice only when the registry package is verified.

Install the exact published version in a clean environment:

```sh
npm install --global slskd-cli@0.1.0-beta.1 --registry=https://registry.npmjs.org/
slskd --help
slskd check
```

Verify that the npm version, tag, source commit, and release notes agree.
Observe installation and Workflow reports during the first 48 hours.
Ask reporters for command names, CLI versions, daemon versions, exit codes, and redacted errors.
Do not request API keys or Private message contents.

## Recover from a defective preview

If credentials leak or a mutation targets the wrong Transfer, stop release promotion immediately.
Deprecate the defective version with a clear explanation.
Publish a corrected prerelease after verification.
Move `next` to a verified version when one exists.
The first preview has no previous published version to restore.
Do not use successful Transfer cancellation as release recovery.
Reconcile ambiguous mutations through slskd before repeating any state-changing command.

See [npm distribution tags](https://docs.npmjs.com/adding-dist-tags-to-packages/) for preview tag management.
