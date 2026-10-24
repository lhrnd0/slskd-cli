import { CliError, compatible, type Context } from "./core.js";
import { canonicalSearchId, searchWatch } from "./search.js";

class ObservationStopped extends Error {
  constructor(readonly exitCode: number) {
    super("Observation stopped.");
  }
}

/** Complete each write before requesting more Candidates, respecting output backpressure. */
async function writeRecord(value: unknown, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    process.stdout.write(`${JSON.stringify(value)}\n`, (error) => {
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Own the process lifecycle only for streaming observation; one-shot output stays unchanged. */
export async function runSearchWatch(
  ctx: Context,
  searchId: string,
  options: { pollIntervalMs: number; watchTimeoutSeconds: number },
): Promise<void> {
  searchId = canonicalSearchId(searchId);
  const controller = new AbortController();
  const stop = (exitCode: number) => {
    controller.abort(new ObservationStopped(exitCode));
    process.stdout.destroy();
  };
  const interrupt = () => stop(130);
  const terminate = () => stop(143);
  const outputError = (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") stop(0);
    else controller.abort(error);
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  process.stdout.on("error", outputError);
  const watchCtx = { ...ctx, signal: controller.signal };
  try {
    await compatible(watchCtx);
    for await (const event of searchWatch(watchCtx, searchId, options)) {
      await writeRecord({ ok: true, result: event }, controller.signal);
    }
  } catch (error) {
    const failure = controller.signal.aborted ? controller.signal.reason : error;
    if (failure instanceof ObservationStopped) {
      process.exitCode = failure.exitCode;
      return;
    }
    const typed =
      failure instanceof CliError ? failure : new CliError("REMOTE", "Unexpected CLI failure.", 7);
    process.exitCode = typed.exitCode;
    try {
      await writeRecord(
        { ok: false, searchId, error: { code: typed.code, message: typed.message } },
        controller.signal,
      );
    } catch (writeError) {
      if (controller.signal.reason instanceof ObservationStopped) {
        process.exitCode = controller.signal.reason.exitCode;
      } else if ((writeError as NodeJS.ErrnoException).code === "EPIPE") {
        process.exitCode = 0;
      }
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    // An aborted write may still report its error after the observer has stopped.
    if (!controller.signal.aborted) process.stdout.off("error", outputError);
  }
}
