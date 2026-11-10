# Private messages

Use the configured slskd account to exchange one-to-one messages with a Soulseek username.
The [message reference](../commands/message.md) contains options and result fields.

## Read a Conversation

```sh
slskd message conversations --unacknowledged
slskd message list 'peer'
```

Reading never acknowledges messages.
Choose incoming messages by their opaque `messageId`, not their numeric `serverId`.

## Send a message

```sh
slskd message send 'peer' --text 'Hello!' --yes
```

A successful send confirms submission only.
It does not establish remote delivery or reading.
After an uncertain send, inspect slskd before sending again.

## Acknowledge incoming messages

```sh
slskd message acknowledge 'peer' --id '<messageId>' --yes
```

Use `--all` only when you intend to acknowledge the entire Conversation, including messages outside visible history.
Inspect per-message outcomes when an acknowledgement fails.
See [acknowledgement behavior](../commands/message.md#acknowledge).

## Observe incoming messages

```sh
slskd message watch --username 'peer' --new-only --timeout 60
```

This skips the initial backlog and observes later incoming messages for up to 60 seconds.
Without `--username`, the watcher discovers Conversations between polls.
Watching never acknowledges messages or sends replies.

## History and observation limits

slskd exposes a limited history window; the CLI has no message archive or persistent cursor.
Restarting can replay pending messages.
Bursts and interruptions can leave gaps, even if observation exits successfully.
See [history metadata](../commands/message.md#history-metadata) and [watch events](../commands/message.md#watch-events).
