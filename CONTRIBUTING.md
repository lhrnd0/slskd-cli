# Contributing

## Pull requests

Create a branch from `main` and open a PR targeting `main`.
Describe the change and include validation evidence.
Both Linux and macOS CI jobs must pass for the current PR revision.
Resolve review findings and obtain approval before merging.
After merge, CI checks the resulting `main` commit again.

## Release PRs

A release PR changes `package.json` to a new version and adds its entry to `CHANGELOG.md`.
Ordinary PRs keep the version unchanged.
After merge and successful `main` checks, CI creates the missing annotated `v<version>` tag.
Existing matching tags remain unchanged. CI fails if a tag conflicts with the verified commit or package version.
Do not create or move release tags from a PR branch.

Source tagging and npm publication are separate steps.
Publication is future work and requires the gates in the [release procedure](docs/releasing.md).

## Commit messages

All commits must follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>[optional scope][optional !]: <description>

[optional body]

[optional footer(s)]
```

Use one of these types:

- `feat`: add or change user-visible behavior
- `fix`: correct a defect
- `docs`: change documentation only
- `test`: add or change tests only
- `refactor`: restructure code without changing behavior
- `perf`: improve performance
- `style`: change formatting without changing behavior
- `build`: change the build system or dependencies
- `ci`: change continuous integration
- `chore`: perform repository maintenance
- `revert`: revert an earlier commit

Write the description in the imperative mood, start it with a lowercase letter, omit the trailing period, and keep the complete header at 100 characters or fewer. A scope should be a short noun describing the affected area, such as `search` or `transfer`.

Mark a breaking change with `!` before the colon, a `BREAKING CHANGE:` footer, or both:

```text
feat(search)!: replace signed references with UUIDs

BREAKING CHANGE: search commands no longer accept signed references.
```

Examples:

```text
feat(search): list stored searches
fix(transfer): validate username before lookup
docs: explain the connection profile
chore(deps): update TypeScript
```

The repository's `commit-msg` hook rejects invalid messages before a commit is created. It shares the Git hook directory managed by Beads; run `bd hooks install` if the repository hooks are not active. To check a message directly, pipe it to the validation script:

```sh
printf '%s\n' 'feat(search): list stored searches' | pnpm commitlint
```
