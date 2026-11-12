import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/** Internal completion signal; only a watch deadline becomes a successful ended event. */
export class WatchDeadline extends Data.TaggedError("WatchDeadline") {}

/** Each pull shares one absolute deadline, including requests and poll delays. */
export function watchDeadline(timeoutSeconds?: number) {
  const deadline = timeoutSeconds === undefined ? undefined : Date.now() + timeoutSeconds * 1000;
  return <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      if (deadline === undefined) return operation;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return Effect.fail(new WatchDeadline());
      return Effect.timeoutOrElse(operation, {
        duration: remaining,
        orElse: () => Effect.fail(new WatchDeadline()),
      });
    });
}
