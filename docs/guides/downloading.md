# Downloading files

Use this Workflow to find files, select a Candidate, and inspect its Transfer.
First, configure your [Connection profile](../reference/configuration.md) and run `slskd check`.

## Find and inspect Candidates

```sh
slskd search create --query 'artist album'
slskd search candidates '<searchId>' --watch
```

Use the returned Search UUID in the second command.
Wait for the watch's end event; follow [Watching Searches](watching-searches.md) if its deadline expires.
To reuse a retained Search, obtain its identifier with `slskd search list`.

Inspect the [Candidate fields](../commands/search.md#candidate-fields) before choosing a file.
Compare filename, path, size, audio attributes, and peer availability against your needs.
Missing metadata does not establish quality or completeness.
If you need the whole release, inspect its [folder](release-folders.md) before enqueueing.

## Enqueue a selection

```sh
slskd transfer enqueue '<searchId>' '<candidateId>' --yes
```

Supply the selected Candidate's identifiers exactly as returned.
Record the returned `transfer.id` and its `username`.
`existing:true` means the CLI found a matching Transfer instead of creating another.

## Observe the Transfer

```sh
slskd transfer show '<username>' '<transferId>'
```

Inspect raw `state`, normalized `status`, `terminal`, progress, and failure detail.
The [Transfer reference](../commands/transfer.md#transfer-fields) explains the current compound-state limitation.
Repeat inspection as needed; the CLI has no Transfer watch command.

slskd controls the final download location.
If `destination` is `null`, the CLI cannot establish the local path.
Transfer completion does not verify local file contents.

After an [uncertain mutation](../reference/errors.md#unknown-mutation-outcome), inspect slskd before repeating enqueue.
Use [Transfer commands](../commands/transfer.md) when you intend to cancel or remove records.
