import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  CliError,
  ConnectionProfile,
  CoreFailure,
  type RequestFailure,
  compatibleEffect,
  failure,
  publicFailure,
  requireYes,
  resolveContextEffect,
  slskdRequestLayer,
} from "./core.js";
import {
  messageAcknowledgeEffect,
  messageConversationsEffect,
  messageListEffect,
  messageSendEffect,
  messageUsername,
  messageWatchStream,
  resolveMessageWatchOptions,
} from "./message.js";
import { runObservationEffect } from "./watch-cli.js";

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

function commandFailure(error: unknown): CoreFailure {
  return error instanceof CliError
    ? failure(error.code, error.message, error.exitCode)
    : failure("REMOTE", "Unexpected CLI failure.", 7);
}

function inputTextEffect(flags: Flags): Effect.Effect<string, CoreFailure> {
  return Effect.gen(function* () {
    const direct = yield* Effect.try({
      try: () => {
        if ((typeof flags.text === "string") === (flags.stdin === true))
          invalid("Supply --text or --stdin, not both.");
        if (typeof flags.text === "string") return flags.text;
        if (process.stdin.isTTY) invalid("--stdin requires piped input or input redirection.");
        return undefined;
      },
      catch: commandFailure,
    });
    const text =
      direct ??
      (yield* Effect.tryPromise({
        try: async () => {
          process.stdin.setEncoding("utf8");
          let text = "";
          for await (const chunk of process.stdin) text += chunk;
          return text;
        },
        catch: () => failure("INPUT", "Could not read message text from stdin.", 2),
      }));
    if (!text.trim())
      return yield* Effect.fail(failure("INVALID_INPUT", "Message text must not be blank.", 2));
    return text;
  });
}

/** Validate this command's complete flag set before configuration or network access. */
function validateMessageCommand(words: string[], flags: Flags) {
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
  return { command, ids, watchOptions };
}

type MessageCommandResult = { exitCode: number; result: unknown } | undefined;

export function runMessageCommandEffect(
  words: string[],
  flags: Flags,
): Effect.Effect<MessageCommandResult, RequestFailure> {
  return Effect.gen(function* () {
    const { command, ids, watchOptions } = yield* Effect.try({
      try: () => validateMessageCommand(words, flags),
      catch: commandFailure,
    });
    const text = command === "send" ? yield* inputTextEffect(flags) : undefined;
    const ctx = yield* resolveContextEffect(flags);
    if (watchOptions !== undefined) {
      yield* runObservationEffect(ctx, messageWatchStream(watchOptions));
      return undefined;
    }
    const operation = Effect.gen(function* () {
      yield* compatibleEffect;
      if (command === "conversations")
        return {
          exitCode: 0,
          result: yield* messageConversationsEffect(flags.unacknowledged === true),
        };
      if (command === "list")
        return {
          exitCode: 0,
          result: yield* messageListEffect(words[2]!, flags.unacknowledged === true),
        };
      if (command === "send")
        return { exitCode: 0, result: yield* messageSendEffect(words[2]!, text!, flags.yes) };
      const { exitCode, ...result } = yield* messageAcknowledgeEffect(
        words[2]!,
        ids,
        flags.all === true,
        flags.yes,
      );
      return { exitCode, result };
    });
    return yield* operation.pipe(
      Effect.provide(slskdRequestLayer.pipe(Layer.provide(Layer.succeed(ConnectionProfile, ctx)))),
    );
  });
}

/** Temporary runtime boundary until command parsing moves to Effect. */
export function runMessageCommand(words: string[], flags: Flags) {
  return Effect.runPromise(
    runMessageCommandEffect(words, flags).pipe(Effect.mapError(publicFailure)),
  );
}
