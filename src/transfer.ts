import * as Effect from "effect/Effect";
import {
  CliError,
  CoreFailure,
  type RequestFailure,
  type SlskdRequest,
  failure,
  requestEffect,
  validateEffect as validate,
  requireYes,
} from "./core.js";

type JsonObject = Record<string, unknown>;

export type TransferProgress = {
  bytesTransferred: number | null;
  size: number | null;
  percent: number | null;
};

export type TransferResult = {
  id: string;
  username: string;
  filename: string | null;
  state: string;
  status: "queued" | "active" | "complete" | "failed" | "cancelled" | "unknown";
  terminal: boolean;
  progress: TransferProgress;
  destination: string | null;
  exception: string | null;
};

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function transferPath(username: string, id: string): string {
  if (
    !username ||
    !username.trim() ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  ) {
    throw new CliError(
      "INVALID_INPUT",
      "A username and valid Transfer identifier are required.",
      2,
    );
  }
  return `/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(id)}`;
}

function normalized(raw: unknown): TransferResult {
  const transfer = object(raw) ?? {};
  const state = string(transfer.state) ?? "Unknown";
  const normalizedState = state.toLowerCase();
  const terminal = [
    "completed",
    "succeeded",
    "errored",
    "failed",
    "cancelled",
    "canceled",
  ].includes(normalizedState);
  let status: TransferResult["status"] = "unknown";
  if (["completed", "succeeded"].includes(normalizedState)) status = "complete";
  else if (["errored", "failed"].includes(normalizedState)) status = "failed";
  else if (["cancelled", "canceled"].includes(normalizedState)) status = "cancelled";
  else if (["queued", "requested", "initializing", "none"].includes(normalizedState))
    status = "queued";
  else if (["inprogress", "in_progress", "transferring"].includes(normalizedState))
    status = "active";

  const transferred = number(transfer.bytesTransferred);
  const size = number(transfer.size);
  const apiPercent = number(transfer.percentComplete);
  const percent =
    apiPercent ??
    (transferred !== null && size !== null && size > 0
      ? (transferred / size) * 100
      : size === 0 && transferred !== null
        ? 0
        : null);
  const destination = string(transfer.destination) ?? string(transfer.localFilename);

  return {
    id: string(transfer.id) ?? "",
    username: string(transfer.username) ?? "",
    filename: string(transfer.filename),
    state,
    status,
    terminal,
    progress: { bytesTransferred: transferred, size, percent },
    destination,
    exception: string(transfer.exception),
  };
}

function missingTransfer(): CoreFailure {
  return failure("TRANSFER_NOT_FOUND", "The specified Transfer was not found.", 7);
}

function mapMissingTransfer(error: RequestFailure): RequestFailure {
  return error instanceof CoreFailure && error.status === 404 ? missingTransfer() : error;
}

function getRawEffect(
  username: string,
  id: string,
): Effect.Effect<unknown, RequestFailure, SlskdRequest> {
  return Effect.gen(function* () {
    const path = yield* validate(() => transferPath(username, id));
    const transfer = yield* requestEffect("GET", path).pipe(Effect.mapError(mapMissingTransfer));
    if (object(transfer)?.username !== username) return yield* Effect.fail(missingTransfer());
    return transfer;
  });
}

/** Get all downloads, flattened from slskd's username/directory response groups. */
export const transferListEffect: Effect.Effect<TransferResult[], RequestFailure, SlskdRequest> =
  Effect.map(requestEffect("GET", "/transfers/downloads"), (raw) => {
    if (!Array.isArray(raw)) return [];
    const results: TransferResult[] = [];
    for (const user of raw) {
      const directories = object(user)?.directories;
      if (!Array.isArray(directories)) continue;
      for (const directory of directories) {
        const files = object(directory)?.files;
        if (!Array.isArray(files)) continue;
        for (const file of files) results.push(normalized(file));
      }
    }
    return results.sort((a, b) => a.username.localeCompare(b.username) || a.id.localeCompare(b.id));
  });

export function transferInspectEffect(
  username: string,
  id: string,
): Effect.Effect<TransferResult, RequestFailure, SlskdRequest> {
  return Effect.map(getRawEffect(username, id), normalized);
}

export function transferCancelEffect(
  username: string,
  id: string,
  yes: unknown,
): Effect.Effect<
  { action: "cancel"; changed: boolean; transfer: TransferResult },
  RequestFailure,
  SlskdRequest
> {
  return Effect.gen(function* () {
    yield* validate(() => requireYes(yes));
    const current = yield* transferInspectEffect(username, id);
    if (current.terminal) return { action: "cancel" as const, changed: false, transfer: current };

    yield* requestEffect(
      "DELETE",
      `${transferPath(username, id)}?remove=false`,
      undefined,
      true,
    ).pipe(Effect.mapError(mapMissingTransfer));
    const transfer = yield* transferInspectEffect(username, id).pipe(
      Effect.mapError(() =>
        failure(
          "AMBIGUOUS_MUTATION",
          "The cancellation request succeeded, but its resulting state could not be read. Query slskd before retrying.",
          9,
        ),
      ),
    );
    return { action: "cancel" as const, changed: true, transfer };
  });
}

export function transferClearEffect(
  yes: unknown,
): Effect.Effect<
  { action: "clear"; scope: "completed-downloads"; changed: true },
  RequestFailure,
  SlskdRequest
> {
  return Effect.gen(function* () {
    yield* validate(() => requireYes(yes));
    yield* requestEffect("DELETE", "/transfers/downloads/all/completed", undefined, true);
    return {
      action: "clear" as const,
      scope: "completed-downloads" as const,
      changed: true as const,
    };
  });
}

export function transferDeleteEffect(
  username: string,
  id: string,
  yes: unknown,
): Effect.Effect<
  { action: "delete"; id: string; username: string; removed: true },
  RequestFailure,
  SlskdRequest
> {
  return Effect.gen(function* () {
    yield* validate(() => requireYes(yes));
    // Confirm existence so idempotent API removal still reports missing records.
    yield* getRawEffect(username, id);
    yield* requestEffect(
      "DELETE",
      `${transferPath(username, id)}?remove=true`,
      undefined,
      true,
    ).pipe(Effect.mapError(mapMissingTransfer));
    return { action: "delete" as const, id, username, removed: true as const };
  });
}
