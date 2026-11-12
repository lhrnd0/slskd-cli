import { deterministicBatchId } from "./batch.js";
import * as Effect from "effect/Effect";
import {
  CliError,
  CoreFailure,
  type RequestFailure,
  type SlskdRequest,
  requestEffect,
  validateEffect as validate,
  requireYes,
} from "./core.js";
import { folderShowEffect, type FolderFile } from "./folder.js";
import { transferInspectEffect, transferListEffect, type TransferResult } from "./transfer.js";

type Outcome = "enqueued" | "existing" | "failed" | "uncertain";
type FileOutcome = {
  fileId: string;
  path: string;
  size: number | null;
  outcome: Outcome;
  transfer: TransferResult | null;
  error?: { code: string; message: string };
};
export type FolderEnqueueResult = {
  exitCode: 0 | 2 | 4 | 7 | 9;
  folderRef: string;
  username: string;
  directory: string;
  files: FileOutcome[];
  skipped: FolderFile[];
  counts: {
    selected: number;
    enqueued: number;
    existing: number;
    failed: number;
    uncertain: number;
    skipped: number;
  };
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function batchId(username: string, files: FolderFile[]): string {
  const sorted = files
    .map((file) => [file.path, file.size])
    .sort(([a], [b]) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
  return deterministicBatchId([username, sorted]);
}
function isHttp(error: RequestFailure, status: number): boolean {
  return error instanceof CoreFailure && error.status === status;
}
function matches(transfer: TransferResult, username: string, file: FolderFile): boolean {
  return (
    transfer.username === username &&
    transfer.filename === file.path &&
    transfer.progress.size === file.size
  );
}
function counts(files: FileOutcome[], skipped: FolderFile[]) {
  return {
    selected: files.length,
    enqueued: files.filter((file) => file.outcome === "enqueued").length,
    existing: files.filter((file) => file.outcome === "existing").length,
    failed: files.filter((file) => file.outcome === "failed").length,
    uncertain: files.filter((file) => file.outcome === "uncertain").length,
    skipped: skipped.length,
  };
}

export function folderEnqueueEffect(
  folderRef: string,
  fileIds: string[],
  all: boolean,
  yes: unknown,
): Effect.Effect<FolderEnqueueResult, RequestFailure, SlskdRequest> {
  return Effect.gen(function* () {
    yield* validate(() => {
      if (!Array.isArray(fileIds) || fileIds.some((id) => typeof id !== "string" || !id))
        throw new CliError("INVALID_INPUT", "File identifiers must be non-empty strings.", 2);
      if (all && fileIds.length)
        throw new CliError("INVALID_INPUT", "Use --all or file identifiers, not both.", 2);
      if (!all && !fileIds.length)
        throw new CliError("INVALID_INPUT", "Select file identifiers or use --all.", 2);
      requireYes(yes);
    });
    const listing = yield* folderShowEffect(folderRef, yes);
    const uniqueIds = [...new Set(fileIds)];
    let selected: FolderFile[];
    let skipped: FolderFile[] = [];
    if (all) {
      selected = listing.files.filter((file) => file.eligible);
      skipped = listing.files.filter((file) => !file.eligible);
    } else {
      const indexed = new Map(listing.files.map((file) => [file.fileId, file]));
      selected = yield* validate(() =>
        uniqueIds.map((id) => {
          const file = indexed.get(id);
          if (!file)
            throw new CliError(
              "INVALID_INPUT",
              "A selected file is not present in the current folder listing.",
              2,
            );
          if (
            !file.eligible ||
            file.isLocked === true ||
            !file.path ||
            !Number.isSafeInteger(file.size) ||
            file.size === null ||
            file.size < 0
          )
            throw new CliError(
              "INVALID_INPUT",
              "A selected file is no longer eligible for enqueue.",
              2,
            );
          return file;
        }),
      );
    }

    const result: FileOutcome[] = selected.map((file) => ({
      fileId: file.fileId,
      path: file.path,
      size: file.size,
      outcome: "failed",
      transfer: null,
    }));
    const finish = (exitCode: 0 | 2 | 4 | 7 | 9): FolderEnqueueResult => ({
      exitCode,
      folderRef: listing.folderRef,
      username: listing.username,
      directory: listing.directory,
      files: result,
      skipped,
      counts: counts(result, skipped),
    });
    if (!selected.length) return finish(2);
    const existing = yield* transferListEffect;
    const pending: FolderFile[] = [];
    selected.forEach((file, index) => {
      const match = existing.find((transfer) => matches(transfer, listing.username, file));
      if (match) {
        result[index]!.outcome = "existing";
        result[index]!.transfer = match;
      } else pending.push(file);
    });
    if (!pending.length) return finish(0);

    const id = batchId(listing.username, pending);
    let response: unknown;
    const posted = yield* Effect.result(
      requestEffect(
        "POST",
        "/transfers/downloads/batches",
        {
          id,
          username: listing.username,
          files: pending.map((file) => ({ filename: file.path, size: file.size })),
        },
        true,
      ),
    );
    if (posted._tag === "Success") response = posted.success;
    else {
      const error = posted.failure;
      if (isHttp(error, 409)) {
        const conflict = yield* Effect.result(
          requestEffect("GET", `/transfers/downloads/batches/${id}`),
        );
        if (conflict._tag === "Success") response = conflict.success;
        else {
          for (const file of pending) {
            const item = result.find((entry) => entry.fileId === file.fileId)!;
            item.outcome = "uncertain";
            item.error = {
              code: "AMBIGUOUS_MUTATION",
              message: "Batch conflict could not be reconciled. Query slskd before retrying.",
            };
          }
          return finish(9);
        }
      } else if (
        error instanceof CoreFailure &&
        (error.code === "AUTHENTICATION" ||
          (error.code === "REMOTE" && [400, 404].some((status) => isHttp(error, status))))
      ) {
        for (const file of pending) {
          const item = result.find((entry) => entry.fileId === file.fileId)!;
          item.outcome = "failed";
          item.error = { code: error.code, message: "slskd rejected the enqueue request." };
        }
        return finish(error.exitCode === 4 ? 4 : 7);
      } else {
        const current = yield* transferListEffect.pipe(
          Effect.orElseSucceed((): TransferResult[] => []),
        );
        for (const file of pending) {
          const item = result.find((entry) => entry.fileId === file.fileId)!;
          const transfer = current.find((candidate) => matches(candidate, listing.username, file));
          if (transfer) {
            item.outcome = "enqueued";
            item.transfer = transfer;
          } else {
            item.outcome = "uncertain";
            item.error = {
              code: "AMBIGUOUS_MUTATION",
              message: "Enqueue outcome is unknown. Query slskd before retrying.",
            };
          }
        }
        return finish(result.some((item) => item.outcome === "uncertain") ? 9 : 0);
      }
    }

    const wrapper = object(response);
    const batch = object(wrapper?.batch);
    const transfers = Array.isArray(batch?.transfers)
      ? batch.transfers
      : Array.isArray(wrapper?.transfers)
        ? wrapper.transfers
        : [];
    const failures = Array.isArray(wrapper?.failures) ? wrapper.failures : [];
    let reconciled: TransferResult[] | undefined;
    const used = new Set<unknown>();
    for (const file of pending) {
      const item = result.find((entry) => entry.fileId === file.fileId)!;
      const raw = transfers.find((candidate) => {
        const value = object(candidate);
        return (
          value?.username === listing.username &&
          value.filename === file.path &&
          value.size === file.size &&
          typeof value.id === "string" &&
          !used.has(value.id)
        );
      });
      const failure = failures.map(object).find((candidate) => candidate?.filename === file.path);
      if (failure) {
        // A failed reconciliation is retried only for the next unresolved file.
        reconciled ??= yield* transferListEffect.pipe(Effect.orElseSucceed(() => undefined));
        const found = reconciled?.find((candidate) => matches(candidate, listing.username, file));
        if (found) {
          item.outcome = "existing";
          item.transfer = found;
        } else {
          item.outcome = "failed";
          item.error = {
            code: "REMOTE",
            message: "slskd reported that this file could not be enqueued.",
          };
        }
      } else if (raw) {
        const transferId = object(raw)?.id as string;
        used.add(transferId);
        const inspected = yield* Effect.result(transferInspectEffect(listing.username, transferId));
        if (inspected._tag === "Success" && matches(inspected.success, listing.username, file)) {
          item.transfer = inspected.success;
          item.outcome = "enqueued";
        } else {
          item.transfer = {
            id: transferId,
            username: listing.username,
            filename: file.path,
            state: "Unknown",
            status: "unknown",
            terminal: false,
            progress: { bytesTransferred: null, size: file.size, percent: null },
            destination: null,
            exception: null,
          };
          item.outcome = "uncertain";
          item.error = {
            code: "AMBIGUOUS_MUTATION",
            message:
              "The Transfer was returned but its current state could not be verified. Query slskd before retrying.",
          };
        }
      } else {
        reconciled ??= yield* transferListEffect.pipe(Effect.orElseSucceed(() => undefined));
        const found = reconciled?.find((candidate) => matches(candidate, listing.username, file));
        if (found) {
          item.transfer = found;
          item.outcome = "enqueued";
        } else {
          item.outcome = "uncertain";
          item.error = {
            code: "AMBIGUOUS_MUTATION",
            message: "No matching Transfer was returned. Query slskd before retrying.",
          };
        }
      }
    }
    return finish(
      result.some((item) => item.outcome === "uncertain")
        ? 9
        : result.some((item) => item.outcome === "failed")
          ? 7
          : 0,
    );
  });
}
