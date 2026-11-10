# Documentation

Use these pages to configure the CLI, learn commands, and complete tasks.
For installation and a first Workflow, start with the [README](../README.md).

## Commands

Each page contains its subcommands, options, result fields, examples, and relevant errors.

| Command                          | Purpose                                                               |
| -------------------------------- | --------------------------------------------------------------------- |
| [check](commands/check.md)       | Check connectivity and slskd compatibility                            |
| [search](commands/search.md)     | Create and inspect Searches, observe Candidates, and discover folders |
| [transfer](commands/transfer.md) | Enqueue, inspect, cancel, and remove download records                 |
| [message](commands/message.md)   | Inspect, send, acknowledge, and watch Private messages                |

## Guides

| Task                                          | Guide                                            |
| --------------------------------------------- | ------------------------------------------------ |
| Select a Candidate and observe its Transfer   | [Downloading files](guides/downloading.md)       |
| Inspect and enqueue a complete folder         | [Release folders](guides/release-folders.md)     |
| Follow Search progress and resume observation | [Watching Searches](guides/watching-searches.md) |
| Read, send, and acknowledge messages          | [Private messages](guides/private-messages.md)   |

## Reference

- [Connection profile](reference/configuration.md): credentials, precedence, and request timeouts.
- [Output](reference/output.md): JSON envelopes, watch streams, and offline help.
- [Errors](reference/errors.md): exit codes, partial results, and uncertain mutations.
- [Glossary](../GLOSSARY.md): project terms.

## Development

Start with [Contributing](../CONTRIBUTING.md) for contribution rules and domain guidance.

- [Setup](development/setup.md): build, run, and check a source checkout.
- [Architecture](development/architecture.md): module responsibilities and state ownership.
- [Issue tracker](../CONTRIBUTING.md#issue-tracker): repository conventions and synchronization.
- [Beads setup](development/setup.md#beads-setup): bootstrap a fresh clone and maintain agent hooks.
- [Releasing](development/releasing.md): verification, source tags, publication, and recovery.

### Decisions and research

- [slskd owns Workflow state](adr/0001-slskd-owns-workflow-state.md).
- [Node.js, TypeScript, and npm distribution](adr/0002-node-typescript-npm-distribution.md).
- [slskd owns Private message state](adr/0003-slskd-owns-private-message-state.md).
- [Search filtering research](research/search-filtering.md): upstream evidence and proposed behavior; proposals are not implemented command reference.

## Upstream slskd

See the [slskd project](https://github.com/slskd/slskd) for server configuration and its HTTP API.
These pages describe the CLI's public commands and JSON output.
