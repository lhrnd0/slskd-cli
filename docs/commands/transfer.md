# transfer

Enqueue selected files and manage slskd download records.
All subcommands accept shared [connection options](../reference/configuration.md#overrides).
slskd controls download locations; these commands never move or delete downloaded files.

| Subcommand          | Purpose                                 |
| ------------------- | --------------------------------------- |
| [enqueue](#enqueue) | Enqueue a Candidate or folder selection |
| [show](#show)       | Inspect one Transfer                    |
| [cancel](#cancel)   | Request cancellation                    |
| [clear](#clear)     | Clear all completed download records    |
| [delete](#delete)   | Remove one download record              |

## enqueue

### Enqueue a Candidate

```sh
slskd transfer enqueue '<searchId>' '<candidateId>' --yes
```

Use identifiers returned by [search](search.md#candidates).
The command rereads slskd results and checks Search availability and Candidate association.
A Candidate needs a username, remote path, byte size, and no reported lock.

It first checks downloads for the same username, remote path, and size.
A matching Transfer returns `existing:true`; a new enqueue uses slskd's batch API.

```json
{
  "ok": true,
  "result": {
    "searchId": "<searchId>",
    "candidateId": "<candidateId>",
    "existing": false,
    "transfer": {
      "id": "<transferId>",
      "username": "peer",
      "filename": "Artist/Album/01 - Track.flac",
      "state": "Queued",
      "status": "queued",
      "terminal": false,
      "progress": { "bytesTransferred": 0, "size": 12345678, "percent": 0 },
      "destination": null,
      "exception": null
    }
  }
}
```

`transfer` uses the [Transfer fields](#transfer-fields) below.
See [Downloading files](../guides/downloading.md) for the full Workflow.

### Enqueue folder files

```sh
slskd transfer enqueue '<folderRef>' '<fileId1>' '<fileId2>' --yes
slskd transfer enqueue '<folderRef>' --all --yes
```

Use references returned by [folder discovery](search.md#folder).
Choose explicit identifiers or `--all`, never both.
Enqueue refreshes the directory and validates selections before submitting them.

`--all` includes eligible artwork and other non-audio files, excludes nested directories, and reports ineligible files under `skipped`.
An explicit identifier becomes invalid when the selected remote path or size changes.
Matching existing Transfers are returned without another enqueue.

| Result field                         | Meaning                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| `folderRef`, `username`, `directory` | The refreshed folder identity                                                       |
| `files`                              | Per-file outcomes and known Transfer details                                        |
| `skipped`                            | Ineligible folder entries excluded by `--all`                                       |
| `counts`                             | Counts for `selected`, `enqueued`, `existing`, `failed`, `uncertain`, and `skipped` |

Each `files` entry contains `fileId`, `path`, `size`, `outcome`, and `transfer`.
`outcome` is `enqueued`, `existing`, `failed`, or `uncertain`.
`transfer` is a Transfer object or `null`; failures can include an `error` code and message.

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
        "size": 12345678,
        "outcome": "existing",
        "transfer": {
          "id": "<transferId>",
          "username": "peer",
          "filename": "Artist/Album\\01 - Track.flac",
          "state": "Queued",
          "status": "queued",
          "terminal": false,
          "progress": { "bytesTransferred": 0, "size": 12345678, "percent": 0 },
          "destination": null,
          "exception": null
        }
      }
    ],
    "skipped": [],
    "counts": {
      "selected": 1,
      "enqueued": 0,
      "existing": 1,
      "failed": 0,
      "uncertain": 0,
      "skipped": 0
    }
  }
}
```

Partial failures retain `result` with `ok:false` and a nonzero exit code.
Successful Transfers remain queued.
No eligible files produces `INVALID_INPUT`, with skipped entries retained when available.
See [Release folders](../guides/release-folders.md) for inspection and recovery.

## show

```sh
slskd transfer show '<username>' '<transferId>'
```

Use the Transfer's `id` returned by enqueue, together with its username.
The command returns one Transfer object under `result`.
A new process can inspect it with the same Connection profile.

### Transfer fields

| Field                                        | Meaning                                                             |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `id`, `username`                             | Transfer identifier and source peer                                 |
| `filename`                                   | Remote filename or path; `null` when unavailable                    |
| `state`                                      | Raw slskd state                                                     |
| `status`                                     | `queued`, `active`, `complete`, `failed`, `cancelled`, or `unknown` |
| `terminal`                                   | Whether the CLI recognizes the state as terminal                    |
| `progress.bytesTransferred`, `progress.size` | Transferred bytes and total byte size                               |
| `progress.percent`                           | Reported or calculated progress percentage                          |
| `destination`                                | Reported local path, or `null` when unavailable                     |
| `exception`                                  | Reported failure detail, or `null`                                  |

Unavailable progress values are `null`.
slskd 0.26.1 does not expose resolved local paths for individual Transfers, so `destination` is normally `null`.
The configured download root does not establish the final file path.
Transfer completion does not verify local file contents.

Current normalization recognizes single state names.
Compound states such as `Completed, Succeeded` can return `status:"unknown"` and `terminal:false`.
Inspect raw `state` as well as normalized fields; do not infer completion from progress alone.

## cancel

```sh
slskd transfer cancel '<username>' '<transferId>' --yes
```

Returns `{action:"cancel",changed,transfer}` under `result`.
If the current state is recognized as terminal, it returns `changed:false` without another cancellation.
Otherwise, it requests cancellation and rereads the Transfer.
The compound-state limitation above also affects this terminal-state check.

## clear

```sh
slskd transfer clear --yes
```

Clears **all completed download records** through slskd's global endpoint.
Returns `{action:"clear",scope:"completed-downloads",changed:true}` under `result`.

## delete

```sh
slskd transfer delete '<username>' '<transferId>' --yes
```

Removes one Transfer record through slskd's `remove=true` endpoint.
It may cancel an active Transfer first.
Returns `{action:"delete",id,username,removed:true}` under `result`.

## Errors

Relevant errors include `INVALID_CANDIDATE`, `MISSING_SEARCH`, `EXPIRED_SEARCH`, `MISSING_CANDIDATE`, `TRANSFER_NOT_FOUND`, and `PARTIAL_ENQUEUE`.
A wrong username cannot identify another peer's Transfer.
Every Transfer mutation requires its own literal `--yes`.
After `AMBIGUOUS_MUTATION`, inspect slskd before repeating the operation.
See [shared errors and partial results](../reference/errors.md).
