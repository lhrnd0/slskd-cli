# Errors and exit codes

The JSON `error.code` identifies the failure; the process exit code groups failures by cause.

| Exit | Meaning                                                                   | Error codes                                                                                                                                                                                             |
| ---: | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    0 | Success                                                                   | —                                                                                                                                                                                                       |
|    2 | Invalid input or acknowledgement                                          | `INVALID_INPUT`, `INVALID_CONFIG`, `INVALID_CANDIDATE`, `ACKNOWLEDGEMENT_REQUIRED`, `INPUT`                                                                                                             |
|    3 | Missing Connection values                                                 | `MISSING_CONFIGURATION`                                                                                                                                                                                 |
|    4 | Authentication or key permissions                                         | `AUTHENTICATION`                                                                                                                                                                                        |
|    5 | Unsupported or unreadable slskd version                                   | `INCOMPATIBLE`                                                                                                                                                                                          |
|    6 | Connection failure                                                        | `CONNECTION`                                                                                                                                                                                            |
|    7 | Remote error, unavailable resource, rejected message, or partial mutation | `REMOTE`, `MISSING_SEARCH`, `EXPIRED_SEARCH`, `MISSING_CANDIDATE`, `TRANSFER_NOT_FOUND`, `UNAVAILABLE_FOLDER`, `PARTIAL_ENQUEUE`, `MISSING_CONVERSATION`, `MESSAGE_REJECTED`, `PARTIAL_ACKNOWLEDGEMENT` |
|    8 | Read request timeout                                                      | `TIMEOUT`                                                                                                                                                                                               |
|    9 | Unknown mutation outcome                                                  | `AMBIGUOUS_MUTATION`                                                                                                                                                                                    |
|  130 | SIGINT during watch observation                                           | —                                                                                                                                                                                                       |
|  143 | SIGTERM during watch observation                                          | —                                                                                                                                                                                                       |

## Explicit acknowledgement

Commands requiring `--yes` need that literal flag on each invocation.
This includes Search deletion, folder discovery, Transfer mutations, message sending, and Message acknowledgement.
`search create` starts a Search without `--yes`.
Read-only inspection and watch commands do not acknowledge messages or enqueue downloads.

## Unknown mutation outcome

`AMBIGUOUS_MUTATION` means a state-changing request may have reached slskd without a confirmed outcome.
A timeout after sending a mutation can produce this error.
The CLI does not automatically retry state-changing requests.

Before repeating the command, inspect the relevant Search, Transfer, or Conversation in slskd.
For an uncertain send, another invocation can create a duplicate message.

## Partial results

Folder enqueue and selected Message acknowledgement can return `ok:false` while preserving successful outcomes under `result`.
A nonzero exit does not undo earlier successful changes.
Inspect per-file or per-message outcomes before deciding what to repeat.

See [folder enqueue](../commands/transfer.md#enqueue-folder-files) and [Message acknowledgement](../commands/message.md#acknowledge).

## Observation deadlines

A watch deadline exits `0`; it does not establish complete observation.
For Searches, resume the same `searchId` when `ended.reason` is `deadline`.
For messages, history limits and interruptions can leave gaps.
See [Search watching](../guides/watching-searches.md) and [message history limits](../guides/private-messages.md#history-and-observation-limits).
