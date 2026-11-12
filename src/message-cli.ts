import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  CliError,
  ConnectionProfile,
  CoreFailure,
  type RequestFailure,
  compatibleEffect,
  failure,
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

function validateMessageOperands(words: string[], flags: Flags) {
  const command = words[1]!;
  const needsUsername = command === "list" || command === "send" || command === "acknowledge";
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
  validateOperands: Effect.Effect<void, CoreFailure>,
): Effect.Effect<MessageCommandResult, RequestFailure> {
  return Effect.gen(function* () {
    yield* validateOperands.pipe(
      Effect.mapError(() => failure("INVALID_INPUT", "Invalid message command arguments.", 2)),
    );
    const { command, ids, watchOptions } = yield* Effect.try({
      try: () => validateMessageOperands(words, flags),
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
