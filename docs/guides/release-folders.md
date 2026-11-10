# Release folders

A Search can find one track while the peer shares an entire release folder.
Start with a Candidate selected through [Downloading files](downloading.md).

## Discover and inspect

```sh
slskd search folder '<searchId>' '<candidateId>' --yes
```

Inspect the returned `files` before selecting a release.
Check track names, byte sizes, audio attributes, and eligibility.
The listing covers the immediate folder; it does not establish release completeness for you.

Discovery requests the directory from the peer and never starts Transfers.
The original Search does not need to contain every file in that folder.
Save the returned `folderRef` and chosen `fileId` values.
See [folder result fields](../commands/search.md#folder).

## Enqueue selected files

```sh
slskd transfer enqueue '<folderRef>' '<fileId1>' '<fileId2>' --yes
```

Alternatively, enqueue all eligible files:

```sh
slskd transfer enqueue '<folderRef>' --all --yes
```

`--all` includes artwork and other non-audio extras.
Use explicit identifiers when you want particular tracks.
See [folder enqueue](../commands/transfer.md#enqueue-folder-files) for eligibility, skipped entries, and result fields.

## Refresh and recover

```sh
slskd search folder '<folderRef>' --yes
```

The reference works across processes without retaining the original Search.
Enqueue also refreshes the directory before selecting files.
If a selected path or size changed, inspect the refreshed listing and select its new identifier.

Inspect every per-file outcome, including when `ok` is `false`.
Earlier successful Transfers remain queued after a partial failure.
Use each known Transfer's `username` and `id` with `slskd transfer show`.
Reconcile uncertain entries through slskd before retrying; see [partial results](../reference/errors.md#partial-results).
