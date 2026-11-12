#!/usr/bin/env node
import {
  CliError,
  compatibleEffect,
  resolveContextEffect,
  ConnectionProfile,
  slskdRequestLayer,
  failure,
  CoreFailure,
  type RequestFailure,
} from "./core.js";
import {
  searchCreateEffect,
  searchCandidatesEffect,
  searchDeleteEffect,
  searchListEffect,
  resolveSearchWatchOptions,
} from "./search.js";
import { folderDiscoverEffect, folderShowEffect } from "./folder.js";
import { folderEnqueueEffect } from "./folder-enqueue.js";
import { transferEnqueueEffect } from "./enqueue.js";
import {
  transferCancelEffect,
  transferClearEffect,
  transferDeleteEffect,
  transferInspectEffect,
} from "./transfer.js";
import { runObservationEffect } from "./watch-cli.js";
import { canonicalSearchId, searchWatchStream } from "./search.js";
import { runMessageCommandEffect } from "./message-cli.js";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { runCommands, type Flags } from "./commands.js";

class StreamedResult {}

function validate<A>(thunk: () => A): Effect.Effect<A, CoreFailure> {
  return Effect.try({
    try: thunk,
    catch: (error) =>
      error instanceof CoreFailure
        ? error
        : error instanceof CliError
          ? failure(error.code, error.message, error.exitCode)
          : failure("REMOTE", "Unexpected CLI failure.", 7),
  });
}

function run(
  words: string[],
  flags: Flags,
  validateOperands: Effect.Effect<void, CoreFailure>,
): Effect.Effect<unknown, RequestFailure> {
  return Effect.gen(function* () {
    const command = words.slice(0, 2).join(" ");
    if (words[0] === "message") {
      const value = yield* runMessageCommandEffect(words, flags, validateOperands);
      if (value === undefined) return new StreamedResult();
      if (value.exitCode === 0) return value.result;
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          result: value.result,
          error: {
            code:
              value.exitCode === 9
                ? "AMBIGUOUS_MUTATION"
                : value.exitCode === 4
                  ? "AUTHENTICATION"
                  : "PARTIAL_ACKNOWLEDGEMENT",
            message:
              "Some acknowledgements could not be confirmed. Inspect per-message outcomes before retrying.",
          },
        })}\n`,
      );
      process.exitCode = value.exitCode;
      return new StreamedResult();
    }
    const ctx = yield* resolveContextEffect(flags);
    if (words[0] === "check")
      return yield* compatibleEffect.pipe(
        Effect.provide(
          slskdRequestLayer.pipe(Layer.provide(Layer.succeed(ConnectionProfile, ctx))),
        ),
      );
    if (command === "search candidates" && flags.watch === true) {
      yield* validateOperands;
      const watchOptions = yield* validate(() =>
        resolveSearchWatchOptions({
          ...(flags["poll-interval-ms"] === undefined
            ? {}
            : { pollIntervalMs: Number(flags["poll-interval-ms"]) }),
          ...(flags["watch-timeout-seconds"] === undefined
            ? {}
            : { watchTimeoutSeconds: Number(flags["watch-timeout-seconds"]) }),
        }),
      );
      const searchId = yield* validate(() => canonicalSearchId(words[2]!));
      yield* runObservationEffect(ctx, searchWatchStream(searchId, watchOptions), { searchId });
      return new StreamedResult();
    }
    return yield* Effect.gen(function* () {
      yield* compatibleEffect;
      yield* validateOperands;
      if (command === "search list") {
        return { searches: yield* searchListEffect };
      }
      if (command === "search create") {
        const lifetime =
          flags["lifetime-seconds"] === undefined ? 60 : Number(flags["lifetime-seconds"]);
        return yield* searchCreateEffect(flags.query as string, lifetime);
      }
      if (command === "search candidates") {
        return {
          searchId: words[2],
          candidates: yield* searchCandidatesEffect(words[2]!),
        };
      }
      if (command === "search delete") {
        return yield* searchDeleteEffect(words[2]!);
      }
      if (command === "search folder") {
        if (words.length === 3) return yield* folderShowEffect(words[2]!, flags.yes);
        return yield* folderDiscoverEffect(words[2]!, words[3]!, flags.yes);
      }
      if (command === "transfer enqueue" && words[2]?.startsWith("folder_")) {
        const { exitCode, ...result } = yield* folderEnqueueEffect(
          words[2]!,
          words.slice(3),
          flags.all === true,
          flags.yes,
        );
        if (exitCode !== 0) {
          process.stdout.write(
            `${JSON.stringify({
              ok: false,
              result,
              error: {
                code:
                  exitCode === 9
                    ? "AMBIGUOUS_MUTATION"
                    : exitCode === 4
                      ? "AUTHENTICATION"
                      : exitCode === 2
                        ? "INVALID_INPUT"
                        : "PARTIAL_ENQUEUE",
                message:
                  exitCode === 2
                    ? "The folder has no eligible files to enqueue; inspect skipped files for details."
                    : "Some selected files could not be confirmed enqueued; inspect per-file outcomes before retrying.",
              },
            })}\n`,
          );
          process.exitCode = exitCode;
          return new StreamedResult();
        }
        return result;
      }
      if (command === "transfer enqueue") {
        return yield* transferEnqueueEffect(words[2]!, words[3]!, flags.yes);
      }
      if (command === "transfer clear") {
        return yield* transferClearEffect(flags.yes);
      }
      if (command === "transfer show") return yield* transferInspectEffect(words[2]!, words[3]!);
      if (command === "transfer cancel")
        return yield* transferCancelEffect(words[2]!, words[3]!, flags.yes);
      return yield* transferDeleteEffect(words[2]!, words[3]!, flags.yes);
    }).pipe(
      Effect.provide(
        slskdRequestLayer.pipe(Layer.provideMerge(Layer.succeed(ConnectionProfile, ctx))),
      ),
    );
  });
}
const exit = await Effect.runPromiseExit(
  runCommands(process.argv.slice(2), (words, flags, validateOperands) =>
    run(words, flags, validateOperands).pipe(
      Effect.map((value) => {
        if (!(value instanceof StreamedResult))
          process.stdout.write(`${JSON.stringify({ ok: true, result: value })}\n`);
      }),
    ),
  ),
);
if (exit._tag === "Failure") {
  const error =
    Option.getOrUndefined(Cause.findErrorOption(exit.cause)) ??
    Result.getOrUndefined(Cause.findDefect(exit.cause));
  const typed =
    error instanceof CliError || error instanceof CoreFailure
      ? error
      : new CliError("REMOTE", "Unexpected CLI failure.", 7);
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: { code: typed.code, message: typed.message } })}\n`,
  );
  process.exitCode = typed.exitCode;
}
