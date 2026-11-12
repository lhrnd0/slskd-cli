import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  CliError,
  ConnectionProfile,
  type Context,
  type RequestFailure,
  type SlskdRequest,
  compatibleEffect,
  publicFailure,
  slskdRequestLayer,
} from "./core.js";

class ObservationStopped extends Data.TaggedError("ObservationStopped")<{
  readonly exitCode: number;
}> {}

class OutputFailure extends Data.TaggedError("OutputFailure")<{
  readonly reason: unknown;
}> {}

/** Complete each write callback before requesting another stream event. */
function writeRecordEffect(value: unknown): Effect.Effect<void, OutputFailure> {
  return Effect.callback((resume) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, (error) => {
      resume(error ? Effect.fail(new OutputFailure({ reason: error })) : Effect.void);
    });
  });
}

/** Retain the external reason; the Effect runtime's interrupt reason is not the caller's reason. */
function observationAborted(signal: AbortSignal): Effect.Effect<never, OutputFailure> {
  return Effect.callback((resume) => {
    const aborted = () => resume(Effect.fail(new OutputFailure({ reason: signal.reason })));
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    return Effect.sync(() => signal.removeEventListener("abort", aborted));
  });
}

/** Shared scoped runtime for read-only NDJSON observers. */
export function runObservationEffect(
  ctx: Context,
  events: Stream.Stream<unknown, RequestFailure, SlskdRequest | ConnectionProfile>,
  errorContext: Record<string, unknown> = {},
): Effect.Effect<void> {
  return Effect.scoped(
    Effect.gen(function* () {
      const lifecycle = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const controller = new AbortController();
          const stop = (exitCode: number) => {
            controller.abort(new ObservationStopped({ exitCode }));
            process.stdout.destroy();
          };
          const interrupt = () => stop(130);
          const terminate = () => stop(143);
          const externalAbort = () => controller.abort(ctx.signal?.reason);
          const outputError = (error: NodeJS.ErrnoException) => {
            if (error.code === "EPIPE") stop(0);
            else controller.abort(error);
          };
          process.on("SIGINT", interrupt);
          process.on("SIGTERM", terminate);
          process.stdout.on("error", outputError);
          ctx.signal?.addEventListener("abort", externalAbort, { once: true });
          if (ctx.signal?.aborted) externalAbort();
          return { controller, interrupt, terminate, externalAbort, outputError };
        }),
        (lifecycle, exit) =>
          Effect.gen(function* () {
            if (Exit.isFailure(exit)) {
              lifecycle.controller.abort(new ObservationStopped({ exitCode: 0 }));
              process.stdout.destroy();
            }
            process.off("SIGINT", lifecycle.interrupt);
            process.off("SIGTERM", lifecycle.terminate);
            ctx.signal?.removeEventListener("abort", lifecycle.externalAbort);
            // Node emits write errors after the write callback, before the next event-loop turn.
            yield* Effect.callback<void>((resume) => {
              const immediate = setImmediate(() => resume(Effect.void));
              return Effect.sync(() => clearImmediate(immediate));
            });
            // Destroyed stdout can report a pending write error before its close event.
            if (process.stdout.destroyed && !process.stdout.closed) {
              yield* Effect.callback<void>((resume) => {
                const closed = () => resume(Effect.void);
                process.stdout.once("close", closed);
                return Effect.sync(() => process.stdout.off("close", closed));
              });
            }
            process.stdout.off("error", lifecycle.outputError);
          }),
      );
      const signal = lifecycle.controller.signal;
      const services = slskdRequestLayer.pipe(
        Layer.provideMerge(Layer.succeed(ConnectionProfile, { ...ctx, signal })),
      );
      const observe = Effect.gen(function* () {
        yield* compatibleEffect;
        yield* Stream.runForEach(events, (event) => writeRecordEffect({ ok: true, result: event }));
      }).pipe(Effect.provide(services));
      const exit = yield* Effect.exit(Effect.raceFirst(observe, observationAborted(signal)));
      if (Exit.isSuccess(exit)) return;
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
      const mapped = error instanceof OutputFailure ? error.reason : publicFailure(error);
      const stopped = signal.aborted ? signal.reason : mapped;
      if (stopped instanceof ObservationStopped) {
        process.exitCode = stopped.exitCode;
        return;
      }
      const typed =
        stopped instanceof CliError
          ? stopped
          : new CliError("REMOTE", "Unexpected CLI failure.", 7);
      process.exitCode = typed.exitCode;
      const written = yield* Effect.exit(
        Effect.raceFirst(
          writeRecordEffect({
            ok: false,
            ...errorContext,
            error: { code: typed.code, message: typed.message },
          }),
          observationAborted(signal),
        ),
      );
      if (Exit.isFailure(written)) {
        const writeError = Option.getOrUndefined(Cause.findErrorOption(written.cause));
        if (signal.reason instanceof ObservationStopped) process.exitCode = signal.reason.exitCode;
        else if (
          writeError instanceof OutputFailure &&
          (writeError.reason as NodeJS.ErrnoException)?.code === "EPIPE"
        )
          process.exitCode = 0;
      }
    }),
  );
}
