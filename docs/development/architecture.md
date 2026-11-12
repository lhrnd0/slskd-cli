# Architecture

The CLI provides a deterministic interface to one trusted slskd instance.
Each process resolves a Connection profile, checks compatibility, and performs the requested operation.
Effect 4.1.4 runs command parsing, configuration, authenticated requests, operations, and watch streams.
One command tree supplies argument definitions, validation policies, and generated offline help.
Schema validates positional arguments at each command's existing validation boundary.
Command annotations control permitted flags and generated help visibility.
A narrow lexical bridge preserves literal booleans, single-dash values, and diagnostic order from command metadata.
slskd owns Search, Transfer, and Private message state.

## Modules

Paths below are relative to the repository root.

| Module                  | Responsibility                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `src/cli.ts`            | Run Effect operations and emit JSON                                                     |
| `src/commands.ts`       | Define commands, validate arguments and flags, and generate offline help                |
| `src/core.ts`           | Resolve configuration, authenticate requests, enforce timeouts, and check compatibility |
| `src/search.ts`         | Create and inspect Searches, normalize Candidates, and produce Search watch events      |
| `src/folder.ts`         | Discover peer directories and return folder and file references                         |
| `src/enqueue.ts`        | Enqueue one Candidate and reconcile matching Transfers                                  |
| `src/folder-enqueue.ts` | Enqueue folder selections and preserve per-file outcomes                                |
| `src/batch.ts`          | Derive deterministic batch identifiers                                                  |
| `src/transfer.ts`       | Inspect and mutate download records                                                     |
| `src/message-cli.ts`    | Validate message inputs, read stdin, and run message operations                         |
| `src/message.ts`        | Inspect, send, acknowledge, and observe Private messages                                |
| `src/watch-cli.ts`      | Write watch streams and handle signals, backpressure, and closed pipes                  |

## Boundaries

- The CLI keeps no Workflow database, message archive, or persistent watch cursor.
- Search identifiers come from slskd. Other opaque references work across processes with unchanged identifying data.
- Callers inspect and select files. The CLI does not rank Candidates.
- slskd chooses download locations. Transfer completion does not establish local file integrity.
- State-changing requests are not automatically retried. Callers reconcile uncertain outcomes through slskd.

See the [Workflow state decision](../adr/0001-slskd-owns-workflow-state.md),
[distribution decision](../adr/0002-node-typescript-npm-distribution.md),
[message state decision](../adr/0003-slskd-owns-private-message-state.md),
and [Effect adoption decision](../adr/0004-effect-runtime-and-services.md).

## Public interface and tests

The public interface consists of commands, JSON results, watch events, and exit codes.
Start with the [command reference](../README.md#commands); internal TypeScript modules are implementation details.
Tests launch the built CLI against fixture HTTP servers.
Package checks also run those tests against a temporary installation.
The executable starts one Effect runtime and provides explicit Connection profile and request layers.
Native fetch, stdin, stdout callbacks, and process signals remain external I/O boundaries.
`@effect/platform-node` 4.1.4 supplies the platform services required by Effect CLI.

For behavior changes, use authoritative slskd documentation and compatible-version upstream source.
Keep proposed behavior in [research](../research/search-filtering.md) separate from implemented command documentation.
