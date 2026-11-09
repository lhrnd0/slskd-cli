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

## Issue tracker

This repository uses Beads (`bd`) for issues and specs in shared mode.
The Beads role is `maintainer`.
Issues live in the Dolt database under `.beads/embeddeddolt/`.
`.beads/issues.jsonl` is an optional passive export.

`bd prime` holds the core rules and command reference; this file adds only what it lacks. If its output (`# Beads Workflow Context`) is not in your context, run `bd prime` before anything else.

Database sync uses `refs/dolt/data` on the Git remote, separate from code branches.
See [sync concepts](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md).
Use `bd dolt push/pull` for normal sync. Do not use `bd import` during normal operation.
Try the configured Git remote before selecting third-party Dolt hosting.

### Agent policy

- Use `bd` for all task tracking and `bd remember` for persistent project knowledge.
- Create an issue before writing code. Claim the issue when work starts.
- Run the checks in [Build & Test](AGENTS.md#build--test) when code changes.
- Create issues for remaining work. Close completed issues before the session ends.
- Report changed files, validation, issue status, and any blocked steps at handoff.
- Commit, push, and sync only when the user explicitly asks.
- Explicit user and orchestrator instructions override generated Beads guidance.

### Agent setup ownership

`AGENTS.md` contains the workflow pointers. `CLAUDE.md` imports `AGENTS.md`.
The contribution guide contains repository-specific Beads rules and triage labels.
The [Beads skill](.agents/skills/beads/SKILL.md) and `bd prime` provide command and session context.

`bd setup claude` and `bd setup codex` can add generated instruction blocks.
Before running them, copy the instruction files to a temporary directory.
After setup, restore the instruction files and preserve the workflow pointers and import.
Keep required hook and skill changes. Avoid duplicate generated instruction blocks.

### Conventions

- **Multi-line body**: `bd create "<title>" --body-file -` with a heredoc.
- **Read comments**: `bd comments <id>`.
- **Comment on an issue**: `bd comments add <id> "..."`.
- **Re-parent an issue**: `bd update <child> --parent <parent>`.
- **Filter by label**: `bd list --label "..."`.
- **Apply / remove labels**: `bd update <id> --add-label "..."` / `--remove-label "..."`. Labels are free-form; nothing to create first.
- **Close**: add a closing comment first.
- **Session end**: create a bead for each follow-up you found.
- **Sync**: `bd dolt push` sends the database to `git+https://github.com/lhrnd0/slskd-cli.git`. Run it only when the user asks.

### Beads instead of planning markdown

Planning skills (`to-spec`, `plan`, `spec-driven-development`, `planning-and-task-breakdown`, `incremental-implementation`, …) write task state to `SPEC.md`, `tasks/plan.md` or `tasks/todo.md`. Write that state to beads instead:

- **Spec** → one epic. Objective, scope and boundaries in `--description`; success criteria in `--acceptance`; tech and design decisions in `--design`.
- **Plan** → architecture decisions and task order in the epic's `--design`.
- **Task list** → one child per task (`bd create --parent=<epic> --acceptance="..."`). Express order with `bd dep add <task> --blocked-by <earlier-task>`, not a numbered list.
- **Next task** → `bd ready --parent <epic>`.
- When a skill says "read `tasks/plan.md`" or "check `SPEC.md`", read the epic with `bd show <epic>` and its children.

Exception: the user asks for a markdown file by name ("write a SPEC.md"). Write it, and keep it out of commits (see [Version control](#version-control)).

### Referring to beads

The database can be discarded without notice, so a bare id can become dead text. Every reference to a bead carries its title.

- Everywhere, commits and PRs included: `` `<id>` — <title> ``.

### Version control

Planning markdown (`SPEC.md`, `tasks/plan.md`, `tasks/todo.md`, per-task spec docs) stays untracked: stage source, tests and config only. Copy those files to `/tmp/<slug>/` if they are worth keeping. If one is already committed, rewrite before pushing:

```
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f \
  --index-filter 'git rm -r --cached --ignore-unmatch tasks SPEC.md <spec-path> > /dev/null' \
  main..HEAD
```

Back the files up to `/tmp/` first: `filter-branch` deletes them from the working tree too. Durable docs that outlive the PR (ADRs, `CLAUDE.md`, design docs) still belong in the tree.

### When a skill says "publish to the issue tracker"

Create a bead with `bd create`.

### When a skill says "fetch the relevant ticket"

Run `bd show <id>`.

### Wayfinding operations

Used by `/wayfinder`. The **map** is an epic with **child** beads as tickets.

- **Map**: an epic labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body in its description. `bd create "<effort>" --type epic --labels wayfinder:map --body-file -`.
- **Child ticket**: `bd create "<question>" --parent <map> --labels wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`).
- **Blocking**: `bd dep add <child> --blocked-by <blocker>`.
- **Frontier query**: `bd ready --parent <map> --unassigned`; first in priority order wins.
- **Claim**: `bd update <n> --claim`, the session's first write.
- **Resolve**: `bd comments add <n> "<answer>"`, then `bd close <n>`, then append a context pointer (gist + id + title) to the map with `bd update <map> --append-notes "..."`.

### Triage labels

| Canonical role    | Beads label       | Meaning                                |
| ----------------- | ----------------- | -------------------------------------- |
| `needs-triage`    | `needs-triage`    | Maintainer needs to evaluate the issue |
| `needs-info`      | `needs-info`      | Waiting for more information           |
| `ready-for-agent` | `ready-for-agent` | Fully specified and ready for an agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation          |
| `wontfix`         | `wontfix`         | Will not be actioned                   |

When a skill refers to a canonical triage role, use the corresponding Beads label.
