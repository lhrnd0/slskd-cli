# Watching Searches

Search creation and Search observation are separate commands.
Create once, then reuse the returned Search UUID when observing.

```sh
slskd search create --query 'artist album' --lifetime-seconds 60
slskd search candidates '<searchId>' --watch
```

The default observation budget is 300 seconds, allowing time beyond the default Search lifetime.
The [Search reference](../commands/search.md#watch-options) lists duration and polling options.

## Read the stream

The stream emits `started`, `progress`, available `candidate` events, and `ended`.
On slskd 0.26.1, counts can rise before Candidates become available through REST.
Keep reading while the watcher runs; an empty snapshot or unchanged count does not establish completion.

| Outcome                           | Next step                                               |
| --------------------------------- | ------------------------------------------------------- |
| `ended` with `reason:"completed"` | Evaluate the Candidates observed by this invocation     |
| `ended` with `reason:"deadline"`  | Watch the same Search again                             |
| `ok:false`                        | Inspect the typed error before deciding how to proceed  |
| Signal termination or closed pipe | Observation stopped; do not assume the Search completed |

Exit `0` alone does not establish Search completion.
A progress record with completed state is not the final event.
See [watch events and finalization limits](../commands/search.md#watch-events).

## Resume observation

```sh
slskd search candidates '<searchId>' --watch --watch-timeout-seconds 300
```

A new watch replays available Candidates and has no saved cursor.
When combining observations, retain Candidates by `candidateId` to avoid counting duplicates.
To request only the current snapshot, omit `--watch`.

After inspection, continue with [Downloading files](downloading.md) or [Release folders](release-folders.md).
