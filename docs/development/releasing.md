# Releasing

The current preview is `0.1.0-beta.1`, distributed under the npm tag `next`.
Its source tag exists; npm publication remains pending.

```text
release PR → approval and merge → main CI → automatic source tag → authorized npm publication
```

## Prepare the source tag

Follow the [release PR rules](../../CONTRIBUTING.md#release-prs).
After both quality jobs pass on a push to `main`, CI creates the missing annotated `v<version>` tag.
PR and manual runs cannot create tags; CI does not publish npm packages.
Existing matching tags on ancestor commits remain unchanged.
Invalid versions and conflicting tags stop the job; inspect logs and fix the cause through a new PR.
Never move an existing release tag to include later changes; use a new version.
See the [CI workflow](../../.github/workflows/ci.yml) and [tag script](../../scripts/release-tag.mjs).

## Verify the candidate

Use Node.js 24 and the pnpm version in `package.json` from a clean candidate checkout.

```sh
pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org/
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm audit --prod --audit-level=high --registry=https://registry.npmjs.org/
pnpm package:check
```

Both Linux and macOS CI jobs must pass; local checks alone are insufficient.
Resolve high or critical production dependency advisories before publication.
Assess development dependency risks separately when dependencies change.

| Evidence       | Required verification                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| Live Workflow  | Search-to-Transfer, folder selections, repeated enqueue, and wrong-username rejection                           |
| Live mutations | Cancellation and deletion with test-owned data; message sending and acknowledgement with a known test recipient |
| Record         | Exact CLI commit, slskd version, and results with credentials and Private message text removed                  |
| Package        | All CLI tests pass against the installed tarball without source files or development dependencies               |

Keep live validation tasks open until their acceptance criteria pass.

## Publish the verified artifact

Publication requires all gates below, even when the source tag already exists:

- Owner confirms package name, publisher identity, and authentication method. Registry `E404` does not establish name availability.
- License is MIT; version and `CHANGELOG.md` notes match the candidate.
- Live validation and npm access blockers are closed, and publication has explicit authorization.
- The tag belongs to `main`; successful `main` CI and the publication tarball match that tagged commit.

Download the exact verified tarball from that CI run; artifacts expire after **seven days**.
PR and branch artifacts are review evidence, not publication candidates.
Local package checks can retain artifacts through `SLSKD_PACKAGE_ARTIFACT_DIR`.
If the artifact expired, repeat every candidate check on the tagged commit before repacking:

```sh
pnpm build
npm pack --ignore-scripts --pack-destination /absolute/path/to/release-artifacts
```

Keep the artifact outside the checkout and record its checksum and source commit.
Use the public registry explicitly:

```sh
npm publish /absolute/path/to/release-artifacts/slskd-cli-0.1.0-beta.1.tgz --tag next --access public --registry=https://registry.npmjs.org/
```

## Verify publication

Install the exact published version in a clean environment:

```sh
npm install --global slskd-cli@0.1.0-beta.1 --registry=https://registry.npmjs.org/
slskd --help
slskd check
```

Verify that the registry version, distribution tag, source commit, and release notes agree.
Only then remove the README's unpublished notice.
For **48 hours**, monitor installation and Workflow reports.
Collect command names, CLI and slskd versions, exit codes, and redacted errors; exclude credentials and Private message text.

## Recover a defective preview

If credentials leak or a mutation targets the wrong Transfer, stop release promotion immediately.
Deprecate the defective version with an explanation, then verify and publish a corrected prerelease.
Move `next` to a verified version when available; the first preview has no previous publication to restore.
Transfer cancellation does not establish release recovery.
Reconcile uncertain mutations through slskd before repeating commands.

## Future publishing automation

The tag job uses `GITHUB_TOKEN`; its push does not automatically trigger another workflow.
Add publication to the verified workflow or explicitly dispatch another workflow, preserving authorization and access gates.
Prefer [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) when supported; keep long-lived credentials outside the repository and CI workflow.
See [GitHub token behavior](https://docs.github.com/en/actions/concepts/security/github_token) and [npm distribution tags](https://docs.npmjs.com/adding-dist-tags-to-packages/).
