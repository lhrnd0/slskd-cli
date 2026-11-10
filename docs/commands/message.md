# message

Exchange Private messages through the Soulseek account connected to slskd.
Chat rooms and an interactive chat screen are outside this release.
All subcommands accept shared [connection options](../reference/configuration.md#overrides).

| Subcommand                      | Purpose                                  |
| ------------------------------- | ---------------------------------------- |
| [conversations](#conversations) | List Conversations and pending counts    |
| [list](#list)                   | Inspect available message history        |
| [send](#send)                   | Send one Private message                 |
| [acknowledge](#acknowledge)     | Explicitly acknowledge incoming messages |
| [watch](#watch)                 | Observe incoming messages                |

## conversations

```sh
slskd message conversations
slskd message conversations --unacknowledged
```

Includes inactive Conversations.
`--unacknowledged` selects Conversations with pending messages.

```json
{
  "ok": true,
  "result": {
    "conversations": [{ "username": "peer", "isActive": true, "unacknowledgedMessageCount": 1 }]
  }
}
```

Each summary contains the peer's `username`, nullable `isActive`, and slskd's `unacknowledgedMessageCount`.
An empty list returns `conversations: []`.

## list

```sh
slskd message list 'peer'
slskd message list 'peer' --unacknowledged
```

Returns `conversation`, chronological `messages` in both directions, and `history` metadata.
`--unacknowledged` filters incoming pending messages within the available history.
Inspection never acknowledges messages.

```json
{
  "ok": true,
  "result": {
    "conversation": { "username": "peer", "isActive": true, "unacknowledgedMessageCount": 1 },
    "messages": [
      {
        "messageId": "<messageId>",
        "serverId": 42,
        "username": "peer",
        "timestamp": "2026-11-01T12:00:00Z",
        "direction": "incoming",
        "text": "Hello!",
        "isAcknowledged": false,
        "wasReplayed": false
      }
    ],
    "history": { "limit": 100, "complete": false, "lossless": false, "returnedBeforeFilter": 1 }
  }
}
```

### Message fields

| Field                   | Meaning                                              |
| ----------------------- | ---------------------------------------------------- |
| `messageId`             | Opaque identifier used for selection                 |
| `serverId`              | Numeric upstream identifier; it can repeat           |
| `username`, `timestamp` | Peer and original message timestamp                  |
| `direction`             | `incoming` or `outgoing`                             |
| `text`                  | Exact message text                                   |
| `isAcknowledged`        | Acknowledgement state reported by slskd              |
| `wasReplayed`           | Upstream replay information; `null` when unavailable |

Message identifiers remain stable across invocations with unchanged identifying data.
Use `messageId` for selection; outgoing messages can have `serverId:0`.

### History metadata

slskd 0.26.1 exposes the latest **100 messages per Conversation**, without pagination.
The pending-message filter runs after this limit; older Unacknowledged messages can be absent.

| Field                  | Meaning                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `limit`                | `100`, the upstream history window                           |
| `complete`, `lossless` | Always `false`, including empty filtered history             |
| `returnedBeforeFilter` | Number of messages available before the CLI's pending filter |

The individual-Conversation pending count can itself be capped at 100.
The CLI keeps no message archive or persistent consumer position.

## send

```sh
slskd message send 'peer' --text 'Hello!' --yes
printf '%s\n' 'Hello!' | slskd message send 'peer' --stdin --yes
```

| Option          | Meaning                                         |
| --------------- | ----------------------------------------------- |
| `--text <text>` | Send the supplied text                          |
| `--stdin`       | Read text from piped or redirected stdin        |
| `--yes`         | Required explicit acknowledgement for this send |

Choose `--text` or `--stdin`, never both.
Blank text is rejected; exact text and stdin newlines are preserved.
Each invocation sends one message.
For text starting with `--`, use `--text=--literal`.

```json
{ "ok": true, "result": { "username": "peer", "submitted": true, "delivered": null, "read": null } }
```

Submission does not prove delivery or remote reading.
slskd's HTTP 200 response for skipped, potentially blacklisted recipients produces `MESSAGE_REJECTED`.
Interrupted sends and server failures can produce `AMBIGUOUS_MUTATION`.
Inspect slskd before repeating an uncertain send; another send can create a duplicate.

## acknowledge

```sh
slskd message acknowledge 'peer' --id '<messageId>' --yes
slskd message acknowledge 'peer' --id '<messageId1>' --id '<messageId2>' --yes
slskd message acknowledge 'peer' --all --yes
```

Choose one or more `--id` values, or `--all`, never both.
Every invocation requires `--yes`.
Message acknowledgement concerns incoming messages; it does not establish that a remote recipient read an outgoing message.

Selected identifiers must resolve to incoming messages in current history before mutations start.
slskd acknowledges by username and numeric ID; reused IDs cannot be acknowledged individually.
The CLI verifies the selected message's state afterward.
Already acknowledged selections return `outcome:"existing"` without another mutation.

```json
{
  "ok": true,
  "result": {
    "username": "peer",
    "all": false,
    "messages": [{ "messageId": "<messageId>", "outcome": "acknowledged" }]
  }
}
```

Selected results contain `username`, `all:false`, and per-message `messages`.
Each entry contains `messageId` and `outcome`, with an optional `error` code and message.
Outcomes are `acknowledged`, `existing`, `failed`, `uncertain`, or `not_attempted`.
After a failure, later selections remain `not_attempted`; earlier successful acknowledgements remain in effect.

`--all` acknowledges the entire Conversation, including messages outside the visible history window.
The command verifies that slskd reports no pending messages afterward.
Success returns `{username,all:true,outcome:"acknowledged"}`.
Concurrent arrivals or replay can prevent verification and produce `outcome:"uncertain"` with an error.
Partial failures retain `result` under `ok:false` and use a nonzero exit code.

## watch

```sh
slskd message watch
slskd message watch --username 'peer' --new-only --poll-interval-ms 1000 --timeout 60
```

| Option                    | Meaning                                                   | Default                                |
| ------------------------- | --------------------------------------------------------- | -------------------------------------- |
| `--username <username>`   | Observe one peer, including its first Conversation        | Discover all Conversations             |
| `--new-only`              | Record the initial snapshot without emitting its messages | Emit initial pending incoming messages |
| `--poll-interval-ms <ms>` | Integer from `100` to `60000`                             | `5000`                                 |
| `--timeout <seconds>`     | Integer from `1` to `2147483`; total observation duration | Until interrupted                      |

The shared `--timeout-ms` controls individual HTTP requests separately.
Watching never replies or acknowledges messages.

### Watch events

Events use the shared [NDJSON envelope](../reference/output.md#watch-streams).

```json
{"ok":true,"result":{"event":"started","username":null,"history":{"limit":100,"complete":false,"lossless":false}}}
{"ok":true,"result":{"event":"message","message":{"messageId":"<messageId>","serverId":42,"username":"peer","timestamp":"2026-11-01T12:00:00Z","direction":"incoming","text":"Hello!","isAcknowledged":false,"wasReplayed":false}}}
{"ok":true,"result":{"event":"ended","reason":"deadline","messageCount":1}}
```

| Event     | Fields                              | Meaning                                                            |
| --------- | ----------------------------------- | ------------------------------------------------------------------ |
| `started` | `username`, `history`               | Initial snapshot succeeded; `username:null` means all peers        |
| `message` | `message`                           | One full incoming Private message                                  |
| `ended`   | `reason:"deadline"`, `messageCount` | Duration expired; count covers emitted messages in this invocation |

The initial snapshot emits available Unacknowledged incoming messages unless `--new-only` is set.
Later snapshots emit newly observed incoming messages, even if another client already acknowledged them.
Duplicate identities are suppressed within this invocation.
A new invocation can replay pending messages; replay does not establish that the peer sent another message.

A duration limit can expire before `started`.
Deadline termination exits `0` without establishing complete capture.
See [watch stream termination](../reference/output.md#watch-streams) for poll failures and signal exit codes.
Bursts beyond the history window and interruptions can lose observable history.
The watcher does not promise lossless capture or exactly-once processing.

## Errors and upstream evidence

Relevant errors include `INVALID_INPUT`, `MISSING_CONVERSATION`, `MESSAGE_REJECTED`, `PARTIAL_ACKNOWLEDGEMENT`, and `AMBIGUOUS_MUTATION`.
The watcher can wait for a filtered username's first Conversation instead of failing because none exists yet.
See [shared errors](../reference/errors.md) and the [Private messages guide](../guides/private-messages.md).

Compatible-version upstream sources:
[Conversation controller](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Messaging/API/Controllers/ConversationsController.cs),
[message service](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Messaging/ConversationService.cs),
and [polling chat UI](https://github.com/slskd/slskd/blob/0.26.1/src/web/src/components/Chat/Chat.jsx).
