# Contributing

Start with [development setup](docs/development/setup.md) and the [architecture overview](docs/development/architecture.md).

## Pull requests

Create a branch from `main` and open a PR targeting `main`.
Describe the change and include validation evidence.
Both Linux and macOS CI jobs must pass for the current PR revision.
Resolve review findings and obtain approval before merging.
After merge, CI checks the resulting `main` commit again.

For command changes, update the matching [command page](docs/README.md#commands) in the same change.
Check syntax against offline help and result fields against implementation and tests.
Check local links, section links, and formatting.
These checks do not automatically detect future documentation drift.

## Release PRs

A release PR updates `package.json` and the matching `CHANGELOG.md` entry.
Ordinary PRs keep the version unchanged.
See the [release procedure](docs/development/releasing.md) for automatic tagging, publication gates, and recovery.

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

Write the description in the imperative mood and start with a lowercase letter.
Omit the trailing period.
Keep the complete header at 100 characters or fewer.
Use a short noun for the scope, such as `search` or `transfer`.

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

The repository's `commit-msg` hook rejects invalid messages before commit creation.
It shares the Git hook directory managed by Beads.
If repository hooks are inactive, run `bd hooks install`.
To check a message directly:

```sh
printf '%s\n' 'feat(search): list stored searches' | pnpm commitlint
```

## Issue tracker

Issues and specs live in Beads (`bd`), in shared mode with the `maintainer` role.
The database is under `.beads/embeddeddolt/`.

Use `bd prime` for core rules, command reference, and project memories.
If its output is already in context, use that output.
The [Beads skill](.agents/skills/beads/SKILL.md) provides the standard workflow.

Repository conventions:

- Store specs, plans, tasks, and follow-up work in Beads.
- If explicitly requested, write named planning Markdown files and keep them untracked.
- Add a closing comment before closing an issue.
- Include the title with each issue reference: `` `<id>` — <title> ``.
- Commit, push, and synchronize remote issue history only when explicitly authorized.
- Explicit user and orchestrator instructions override generated Beads guidance.

Issue sync uses `bd dolt pull` and `bd dolt push`, separately from source branches.
The sync remote is `git+https://github.com/lhrnd0/slskd-cli.git`.
For a new checkout, follow [Beads setup](docs/development/setup.md#beads-setup).

## Domain documentation

This repository has one domain context.
Before exploring or changing behavior, read [GLOSSARY.md](GLOSSARY.md) and relevant [ADRs](docs/adr/).
Use the glossary's terms in code, documentation, and issues.
Explain any conflict with an existing ADR before proposing a different approach.
Add glossary entries only when a project-specific term needs a definition.
Keep implementation details out of the glossary.
Record an ADR only for a lasting trade-off that future contributors need to understand.

## Triage labels

| Canonical role    | Beads label       | Meaning                                |
| ----------------- | ----------------- | -------------------------------------- |
| `needs-triage`    | `needs-triage`    | Maintainer needs to evaluate the issue |
| `needs-info`      | `needs-info`      | Waiting for more information           |
| `ready-for-agent` | `ready-for-agent` | Fully specified and ready for an agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation          |
| `wontfix`         | `wontfix`         | Will not be actioned                   |

When a skill refers to a canonical triage role, use the corresponding Beads label.
