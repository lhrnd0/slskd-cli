---
mode: shared
tracker: beads
role: maintainer
---

# Issue tracker: Beads

Issues and specs for this repo live in beads (`bd`), in the Dolt database under `.beads/`. `.beads/issues.jsonl` is a passive export.

`bd prime` holds the core rules and command reference; this file adds only what it lacks. If its output (`# Beads Workflow Context`) is not in your context, run `bd prime` before anything else.

## Conventions

- **Multi-line body**: `bd create "<title>" --body-file -` with a heredoc.
- **Read comments**: `bd comments <id>`.
- **Comment on an issue**: `bd comments add <id> "..."`.
- **Re-parent an issue**: `bd update <child> --parent <parent>`.
- **Filter by label**: `bd list --label "..."`.
- **Apply / remove labels**: `bd update <id> --add-label "..."` / `--remove-label "..."`. Labels are free-form; nothing to create first.
- **Close**: add a closing comment first.
- **Session end**: create a bead for each follow-up you found.
- **Sync**: `bd dolt push` sends the database to `git+https://github.com/lhrnd0/slskd-cli.git`. Run it only when the user asks.

## Beads instead of planning markdown

Planning skills (`to-spec`, `plan`, `spec-driven-development`, `planning-and-task-breakdown`, `incremental-implementation`, …) write task state to `SPEC.md`, `tasks/plan.md` or `tasks/todo.md`. Write that state to beads instead:

- **Spec** → one epic. Objective, scope and boundaries in `--description`; success criteria in `--acceptance`; tech and design decisions in `--design`.
- **Plan** → architecture decisions and task order in the epic's `--design`.
- **Task list** → one child per task (`bd create --parent=<epic> --acceptance="..."`). Express order with `bd dep add <task> --blocked-by <earlier-task>`, not a numbered list.
- **Next task** → `bd ready --parent <epic>`.
- When a skill says "read `tasks/plan.md`" or "check `SPEC.md`", read the epic with `bd show <epic>` and its children.

Exception: the user asks for a markdown file by name ("write a SPEC.md"). Write it, and keep it out of commits (see **Version control**).

## Referring to beads

The database can be discarded without notice, so a bare id can become dead text. Every reference to a bead carries its title.

- Everywhere, commits and PRs included: `` `<id>` — <title> ``.

## Version control

Planning markdown (`SPEC.md`, `tasks/plan.md`, `tasks/todo.md`, per-task spec docs) stays untracked: stage source, tests and config only. Copy those files to `/tmp/<slug>/` if they are worth keeping. If one is already committed, rewrite before pushing:

```
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f \
  --index-filter 'git rm -r --cached --ignore-unmatch tasks SPEC.md <spec-path> > /dev/null' \
  main..HEAD
```

Back the files up to `/tmp/` first: `filter-branch` deletes them from the working tree too. Durable docs that outlive the PR (ADRs, `CLAUDE.md`, design docs) still belong in the tree.

## When a skill says "publish to the issue tracker"

Create a bead with `bd create`.

## When a skill says "fetch the relevant ticket"

Run `bd show <id>`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is an epic with **child** beads as tickets.

- **Map**: an epic labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body in its description. `bd create "<effort>" --type epic --labels wayfinder:map --body-file -`.
- **Child ticket**: `bd create "<question>" --parent <map> --labels wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`).
- **Blocking**: `bd dep add <child> --blocked-by <blocker>`.
- **Frontier query**: `bd ready --parent <map> --unassigned`; first in priority order wins.
- **Claim**: `bd update <n> --claim`, the session's first write.
- **Resolve**: `bd comments add <n> "<answer>"`, then `bd close <n>`, then append a context pointer (gist + id + title) to the map with `bd update <map> --append-notes "..."`.
