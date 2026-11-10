# Development setup

Use Node.js 24 or later and the pnpm version declared in `package.json`.
If Node.js includes Corepack but pnpm is unavailable, run `corepack enable` once.

## Build and run

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js --help
```

Use `node dist/cli.js` in place of `slskd` in the documentation examples.
Node needs the complete `dist/cli.js` path; `dist` is a directory.
Rebuild after source changes.

To register the checkout's command globally:

```sh
pnpm add -g .
slskd --help
```

With pnpm 12, use `pnpm add -g .`; `pnpm link --global` is no longer supported.
See [Connection profile](../reference/configuration.md) before running operational commands.

## Checks

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm package:check
```

`pnpm test` builds the CLI and runs the existing tests against fixture servers.
CI checks Linux and macOS with Node.js 24.
Windows remains unverified.

| Command              | Purpose                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| `pnpm format`        | Apply oxfmt formatting                                                        |
| `pnpm lint:fix`      | Apply safe oxlint fixes                                                       |
| `pnpm package:check` | Verify a packed installation without source files or development dependencies |

The package check uses a temporary global prefix, production dependencies, and disabled installation scripts.
It checks package contents, offline help, fixture-backed `check`, and all CLI tests against the installed package.
It uses the public npm registry and removes temporary files afterward.
See [Releasing](releasing.md) for artifact retention and publication requirements.

## Documentation checks

For each documented command, run `node dist/cli.js <command> --help`.
Compare syntax, arguments, options, defaults, and limits.
Check JSON fields and behavior against implementation and existing tests.
Check local links and section links, then run `pnpm format:check`.
Use fixture tests for mutations; documentation review does not require live state changes.

## Beads setup

Install [Beads](https://github.com/gastownhall/beads) separately from the project's pnpm dependencies.
For a fresh clone, bootstrap before starting a coding agent or running other Beads commands:

```sh
git clone git@github.com:lhrnd0/slskd-cli.git
cd slskd-cli
chmod 700 .beads
git config --local beads.role maintainer
bd bootstrap --yes
bd config get issue_prefix # should print slskd-cli
bd stats
bd ready
```

For a contributor checkout, replace `maintainer` with `contributor`.
A normal clone does not fetch the issue history under `refs/dolt/data`.
`bd bootstrap` restores published history using `.beads/config.yaml`; `bd init` is for new projects.
Another checkout's issues appear only after that checkout publishes them.
See upstream [clone and sync setup](https://github.com/gastownhall/beads/blob/main/docs/getting-started/sync-setup.md).

If the prefix or expected issues are missing, stop and inspect local data and remote history.
Back up local data before recovery; setting a prefix alone does not restore issues.

### Maintaining agent hooks

Before `bd setup claude` or `bd setup codex`, copy existing instruction files to a temporary directory.
After setup, restore those files while retaining required hook and skill changes.
Preserve workflow pointers in `AGENTS.md` and the `@AGENTS.md` import in `CLAUDE.md`.
This keeps generated Beads instructions from duplicating the existing guidance.

See [tracker conventions](../../CONTRIBUTING.md#issue-tracker) before working on issues.
