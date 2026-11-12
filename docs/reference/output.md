# Output

Operational commands return machine-readable JSON on stdout and never prompt.
The CLI does not print the API key.
stderr is reserved for process-level failures.

## One-shot commands

A one-shot command emits exactly one JSON object followed by a newline.

```json
{ "ok": true, "result": { "compatible": true, "version": "0.26.1.0", "apiKeyRole": "unverified" } }
```

Failures provide an error code and message:

```json
{
  "ok": false,
  "error": {
    "code": "MISSING_CONFIGURATION",
    "message": "Configure baseUrl and apiKey in the connection profile, environment, or flags."
  }
}
```

Partial mutations can also preserve a `result` object alongside `error`.
Always inspect both the envelope and the [exit code](errors.md).
Command pages describe their result fields; unavailable metadata is commonly `null`.
Examples use placeholders such as `<searchId>` for values returned by earlier commands.
Replace placeholders before running commands.

## Watch streams

Watch commands emit newline-delimited JSON, also called NDJSON.
Each line uses the same envelope; successful events appear under `result`.

| Watch command               | Event reference                                       |
| --------------------------- | ----------------------------------------------------- |
| `search candidates --watch` | [Search events](../commands/search.md#watch-events)   |
| `message watch`             | [Message events](../commands/message.md#watch-events) |

The CLI respects output backpressure.
A failed poll emits a typed error and exits without automatic retries or a successful end event.
SIGINT and SIGTERM exit with `130` and `143`, respectively.
A closed output pipe stops observation with exit `0`.
Signal termination does not emit a successful end event.

## Offline help

Help is plain text and works without configuration or a connection to slskd.

```sh
slskd --help
slskd search --help
slskd transfer enqueue --help
slskd help message watch
```

Running `slskd`, `slskd search`, `slskd transfer`, or `slskd message` without further arguments also displays help.

Help comes from the Effect command tree.
Use `slskd <command> --help` or `slskd help <command>` to inspect commands and options offline.
Help wording and layout can change without changing operational JSON.
