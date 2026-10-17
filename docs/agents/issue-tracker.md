# Issue Tracker

Issues are tracked locally with [Beads](https://github.com/gastownhall/beads) using the `bd` CLI. The source of truth is the repository's local Dolt database under `.beads/dolt/`; `.beads/issues.jsonl` is only a passive export.

## Working with issues

- Run `bd ready` to find unblocked work.
- Run `bd show <id>` to inspect an issue.
- Run `bd update <id> --claim` before starting implementation.
- Run `bd create` to record new durable work and `bd close <id>` when it is complete.
- Run `bd prime` to refresh the workflow context.

Do not use GitHub, GitLab, or local Markdown files as alternate issue trackers for this repository.
