# search

Create Searches, inspect Candidates, and discover peer folders.
All subcommands accept shared [connection options](../reference/configuration.md#overrides).

| Subcommand                | Purpose                                            |
| ------------------------- | -------------------------------------------------- |
| [list](#list)             | List Searches stored in slskd                      |
| [create](#create)         | Start a literal Search query                       |
| [candidates](#candidates) | Inspect Candidates or watch Search progress        |
| [folder](#folder)         | Discover or refresh a Candidate's immediate folder |
| [delete](#delete)         | Delete a Search and its responses                  |

## list

```sh
slskd search list
```

Returns active and completed Searches, including older Searches still retained by slskd.
It does not fetch Candidates.

```json
{
  "ok": true,
  "result": {
    "searches": [
      {
        "searchId": "<searchId>",
        "query": "artist album",
        "state": "Completed, TimedOut",
        "startedAt": "2026-11-01T12:00:00Z",
        "endedAt": "2026-11-01T12:01:00Z",
        "responseCount": 12,
        "fileCount": 48,
        "lockedFileCount": 3
      }
    ]
  }
}
```

Each summary contains a `searchId`, `query`, raw `state`, timestamps, and response, file, and locked-file counts.
Unavailable metadata is `null`; an empty instance returns `searches: []`.
Use the listed UUID directly with `candidates`, `folder`, `delete`, or Candidate enqueue.

## create

```sh
slskd search create --query 'artist album' --lifetime-seconds 60
```

| Option                         | Meaning                                 | Default |
| ------------------------------ | --------------------------------------- | ------- |
| `--query <text>`               | Required, nonblank literal Search query | —       |
| `--lifetime-seconds <seconds>` | Integer from `5` to `300`               | `60`    |

The CLI passes the query without rewriting it or inferring filters.
This command does not require `--yes`.

```json
{ "ok": true, "result": { "searchId": "<searchId>", "lifetimeSeconds": 60 } }
```

`searchId` is slskd's UUID, shared across all Search commands.
Previous signed CLI Search references are unsupported; use `list` to obtain the UUID.
The lifetime controls collection, not how long completed Candidates remain available.
slskd owns retention; the CLI imposes no separate age limit.

For slskd 0.26.1, the CLI converts seconds to milliseconds for the upstream timeout field.
That version interprets the field in milliseconds despite describing it as seconds.

## candidates

```sh
slskd search candidates '<searchId>'
slskd search candidates '<searchId>' --watch --poll-interval-ms 1000 --watch-timeout-seconds 300
```

Without `--watch`, returns the current `{searchId,candidates:[...]}` snapshot.
The CLI does not rank or select Candidates.

```json
{
  "ok": true,
  "result": {
    "searchId": "<searchId>",
    "candidates": [
      {
        "candidateId": "<candidateId>",
        "searchId": "<searchId>",
        "username": "peer",
        "path": "Artist/Album/01 - Track.flac",
        "filename": "01 - Track.flac",
        "extension": ".flac",
        "size": 12345678,
        "queueLength": 0,
        "hasFreeUploadSlot": true,
        "uploadSpeed": 1200000,
        "bitRate": 900,
        "length": 240,
        "sampleRate": 44100,
        "bitDepth": 16,
        "isVariableBitRate": false,
        "isLocked": false
      }
    ]
  }
}
```

### Candidate fields

| Fields                                            | Meaning                                            |
| ------------------------------------------------- | -------------------------------------------------- |
| `candidateId`, `searchId`                         | Opaque Candidate identifier and its Search UUID    |
| `username`, `path`, `filename`                    | Source peer, remote path, and basename             |
| `extension`, `size`                               | Reported extension and byte size                   |
| `queueLength`, `hasFreeUploadSlot`, `uploadSpeed` | Reported peer availability and upload speed        |
| `bitRate`, `length`, `sampleRate`, `bitDepth`     | Available parsed audio attributes                  |
| `isVariableBitRate`, `isLocked`                   | Reported variable-bitrate and locked-file metadata |

Unavailable metadata is `null`.
Extensions reflect upstream metadata and can be empty.
Candidate identifiers belong to their Search; pass both identifiers when enqueueing.

### Watch options

| Option                              | Meaning                                                  | Default |
| ----------------------------------- | -------------------------------------------------------- | ------- |
| `--watch`                           | Emit NDJSON events instead of one snapshot               | Off     |
| `--poll-interval-ms <ms>`           | Integer from `100` to `60000`                            | `1000`  |
| `--watch-timeout-seconds <seconds>` | Integer from `1` to `3600`; bounds the whole observation | `300`   |

Watch options require `--watch`.
The shared `--timeout-ms` still bounds each HTTP request separately.

### Watch events

Every event appears under `result` in the shared [output envelope](../reference/output.md#watch-streams).

| Event       | Fields                                                               | Meaning                                                    |
| ----------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| `started`   | `searchId`                                                           | Observation attached successfully                          |
| `progress`  | `searchId`, `state`, `responseCount`, `fileCount`, `lockedFileCount` | Raw Search state and counts on every successful state poll |
| `candidate` | `searchId`, `candidate`                                              | One full normalized Candidate                              |
| `ended`     | `searchId`, `reason`, `candidateCount`                               | Observation ended through completion or its deadline       |

```json
{"ok":true,"result":{"event":"started","searchId":"<searchId>"}}
{"ok":true,"result":{"event":"progress","searchId":"<searchId>","state":"InProgress","responseCount":12,"fileCount":48,"lockedFileCount":3}}
{"ok":true,"result":{"event":"ended","searchId":"<searchId>","reason":"deadline","candidateCount":0}}
```

Progress includes initial and completed snapshots, even when counts do not change.
Unavailable counts are `null`.
Search counts describe slskd's Search; `candidateCount` counts distinct Candidates emitted during this invocation.
Metadata changes do not emit a second event for an existing Candidate identifier.

slskd 0.26.1 publishes accumulated Candidates through REST when the Search finalizes.
Counts can increase while the Candidate list remains empty.
The watcher provides live progress without promising incremental Candidate arrivals.

When state includes `Completed`, the CLI fetches one final response snapshot, then emits `ended` with `reason: "completed"`.
`Completed` can accompany `TimedOut`, `Cancelled`, or `Errored`.
A completed progress record alone is not the end event.
The final snapshot does not guarantee a lossless result set during upstream response finalization.
See [finalization evidence](../research/search-filtering.md#rest-delivery-and-freshness-limitation).

`reason: "deadline"` exits successfully without establishing Search completion.
A new invocation replays available Candidates and deduplicates only within that invocation.
See [Watching Searches](../guides/watching-searches.md) for resuming and combining results.
See [watch stream termination](../reference/output.md#watch-streams) for errors, signals, and closed pipes.

## folder

```sh
slskd search folder '<searchId>' '<candidateId>' --yes
slskd search folder '<folderRef>' --yes
```

Discovery requests the Candidate's immediate directory from its peer.
Refresh uses a returned `folderRef` without requiring the original Search.
Both forms require `--yes` and use the configured request timeout.
Neither form starts Transfers.

The result contains `folderRef`, `username`, `directory`, and `files`.

```json
{
  "ok": true,
  "result": {
    "folderRef": "<folderRef>",
    "username": "peer",
    "directory": "Artist/Album",
    "files": [
      {
        "fileId": "<fileId>",
        "path": "Artist/Album\\01 - Track.flac",
        "filename": "01 - Track.flac",
        "size": 12345678,
        "extension": ".flac",
        "bitRate": 900,
        "length": 240,
        "sampleRate": 44100,
        "bitDepth": 16,
        "isVariableBitRate": false,
        "isLocked": false,
        "eligible": true,
        "ineligibleReason": null
      }
    ]
  }
}
```

Each file includes an opaque `fileId`, remote path, basename, byte size, extension, and available audio attributes.
`eligible` indicates whether the file can be selected for enqueue.
`ineligibleReason` explains invalid filenames, nested paths, invalid sizes, or reported locks; otherwise it is `null`.
Other unavailable metadata is `null`.
Identifiers change when their identifying remote path or size changes.
See [Release folders](../guides/release-folders.md) before choosing files.

## delete

```sh
slskd search delete '<searchId>' --yes
```

Deletes the Search and its stored responses.
Returns `{searchId,deleted:true}` under `result`.
After an uncertain deletion, inspect `search list` before deciding whether to retry.

## Errors and upstream evidence

Relevant errors include `INVALID_INPUT`, `MISSING_SEARCH`, `EXPIRED_SEARCH`, `MISSING_CANDIDATE`, and `UNAVAILABLE_FOLDER`.
Missing directories and incomplete responses are errors, rather than successful empty folders.
Expired or missing Searches are errors, rather than normal watch completion.
See [shared errors](../reference/errors.md) for connection failures and uncertain mutations.

Compatible-version upstream sources:
[Search service](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Search/SearchService.cs),
[Search model](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Search/Types/Search.cs),
[Search controller](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Search/API/Controllers/SearchesController.cs),
[Search states](https://github.com/jpdillingham/Soulseek.NET/blob/10.0.2/src/SearchStates.cs),
and [peer-directory controller](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Users/API/Controllers/UsersController.cs).
