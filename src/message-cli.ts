import { CliError, compatible, requireYes, resolveContext } from "./core.js";
import {
  messageAcknowledge,
  messageConversations,
  messageList,
  messageSend,
  messageUsername,
  messageWatch,
  resolveMessageWatchOptions,
} from "./message.js";
import { runObservation } from "./watch-cli.js";

type Flags = Record<string, string | boolean | string[]>;

export const MESSAGE_FLAGS = [
  "text",
  "stdin",
  "id",
  "unacknowledged",
  "username",
  "new-only",
  "timeout",
];

export const MESSAGE_HELP = new Map<string, string>([
  [
    "message",
    `Usage: slskd message <command>

Commands:
  conversations                 List all conversations, including inactive ones
  list <username>               Inspect available message history
  send <username>               Send one private message with --yes
  acknowledge <username>        Acknowledge selected incoming messages with --yes
  watch                         Watch incoming private messages as NDJSON

Observation never acknowledges messages. slskd owns history; the CLI keeps no archive.
Run "slskd message <command> --help" for details.`,
  ],
  [
    "message conversations",
    `Usage: slskd message conversations [--unacknowledged] [connection options]

List conversations, including inactive ones. --unacknowledged selects those with pending messages.`,
  ],
  [
    "message list",
    `Usage: slskd message list <username> [--unacknowledged] [connection options]

Inspect both directions in chronological order without acknowledging messages.
--unacknowledged selects pending incoming messages within the available history.
slskd 0.26.1 exposes only the latest 100 messages per conversation, with no pagination.
Older pending messages may be absent. history.complete is always false.
Use the opaque messageId values with message acknowledge; numeric server IDs can be reused.`,
  ],
  [
    "message send",
    `Usage: slskd message send <username> --text <text> --yes [connection options]
       slskd message send <username> --stdin --yes [connection options]

Send exactly one message. Text is preserved, including stdin newlines; blank text is rejected.
Use --text=<text> for text beginning with --. --text and --stdin are mutually exclusive.
Success confirms submission, not delivery or remote reading. No automatic retries.
After AMBIGUOUS_MUTATION, inspect slskd before deciding whether to send again.`,
  ],
  [
    "message acknowledge",
    `Usage: slskd message acknowledge <username> --id <messageId> [--id <messageId> ...] --yes
       slskd message acknowledge <username> --all --yes

Acknowledge selected incoming messages from message list or message watch.
Use --all only to acknowledge the entire conversation, including messages outside visible history.
Selections are validated before mutation. Reused server IDs cannot be acknowledged individually.
Success is verified against slskd. Partial results survive failures; later selections are not attempted.
Acknowledgement is not a remote read receipt. No automatic retries.`,
  ],
  [
    "message watch",
    `Usage: slskd message watch [--username <username>] [--new-only] [connection options]

Poll incoming messages as NDJSON. Defaults to every 5000 ms and runs until interrupted.
  --poll-interval-ms <ms>        Integer 100..60000; default 5000
  --timeout <seconds>            Integer 1..2147483; optional total observation duration
  --username <username>          Watch one username, including its first incoming message
  --new-only                     Skip the initial unacknowledged backlog

Emit started, message, and ended/deadline events. By default, emit available pending messages first.
Deduplicate within this invocation only. Restarting may replay unacknowledged messages.
Another client's acknowledgement does not hide newly observed messages after startup.
No archive, persistent cursor, delivery receipt, or lossless capture guarantee.
slskd exposes only the latest 100 messages per conversation. Bursts and interruptions can lose history.
Failed polls exit with typed errors. No automatic retries. SIGINT/SIGTERM exit 130/143.
Watching is read-only; acknowledge messages separately with --yes.`,
  ],
]);

function invalid(message: string): never {
  throw new CliError("INVALID_INPUT", message, 2);
}

async function inputText(flags: Flags): Promise<string> {
  if ((typeof flags.text === "string") === (flags.stdin === true))
    invalid("Supply --text or --stdin, not both.");
  let text: string;
  if (typeof flags.text === "string") text = flags.text;
  else {
    if (process.stdin.isTTY) invalid("--stdin requires piped input or input redirection.");
    process.stdin.setEncoding("utf8");
    text = "";
    try {
      for await (const chunk of process.stdin) text += chunk;
    } catch {
      throw new CliError("INPUT", "Could not read message text from stdin.", 2);
    }
  }
  if (!text.trim()) invalid("Message text must not be blank.");
  return text;
}

/** Validate this command's complete flag set before configuration or network access. */
export async function runMessageCommand(words: string[], flags: Flags) {
  const command = words[1];
  const allowed: Record<string, string[]> = {
    conversations: ["unacknowledged"],
    list: ["unacknowledged"],
    send: ["text", "stdin", "yes"],
    acknowledge: ["id", "all", "yes"],
    watch: ["username", "new-only", "poll-interval-ms", "timeout"],
  };
  if (command === undefined || !Object.hasOwn(allowed, command))
    invalid("Unknown message command.");
  const validFlags = new Set(["base-url", "api-key", "timeout-ms", ...allowed[command]!]);
  if (Object.keys(flags).some((flag) => !validFlags.has(flag)))
    invalid("A flag is not valid for this message command.");
  const needsUsername = command === "list" || command === "send" || command === "acknowledge";
  if (words.length !== (needsUsername ? 3 : 2)) invalid("Invalid message command arguments.");
  if (needsUsername) messageUsername(words[2]!);
  if (command === "send" || command === "acknowledge") requireYes(flags.yes);
  const ids = Array.isArray(flags.id) ? flags.id : typeof flags.id === "string" ? [flags.id] : [];
  if (command === "acknowledge" && (flags.all === true) === ids.length > 0)
    invalid("Select one or more --id message references or use --all, not both.");
  const text = command === "send" ? await inputText(flags) : undefined;
  const watchOptions =
    command === "watch"
      ? resolveMessageWatchOptions({
          ...(typeof flags.username === "string" ? { username: flags.username } : {}),
          newOnly: flags["new-only"] === true,
          ...(flags["poll-interval-ms"] === undefined
            ? {}
            : { pollIntervalMs: Number(flags["poll-interval-ms"]) }),
          ...(flags.timeout === undefined ? {} : { timeoutSeconds: Number(flags.timeout) }),
        })
      : undefined;
  const ctx = resolveContext(flags);
  if (watchOptions !== undefined) {
    await runObservation(ctx, (watchCtx) => messageWatch(watchCtx, watchOptions));
    return undefined;
  }
  await compatible(ctx);
  if (command === "conversations")
    return { exitCode: 0, result: await messageConversations(ctx, flags.unacknowledged === true) };
  if (command === "list")
    return {
      exitCode: 0,
      result: await messageList(ctx, words[2]!, flags.unacknowledged === true),
    };
  if (command === "send")
    return { exitCode: 0, result: await messageSend(ctx, words[2]!, text!, flags.yes) };
  const { exitCode, ...result } = await messageAcknowledge(
    ctx,
    words[2]!,
    ids,
    flags.all === true,
    flags.yes,
  );
  return { exitCode, result };
}
