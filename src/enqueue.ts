import { deterministicBatchId } from "./batch.js";
import * as Effect from "effect/Effect";
import {
  CoreFailure,
  type RequestFailure,
  type SlskdRequest,
  failure,
  requestEffect,
} from "./core.js";
import { resolveCandidateEffect } from "./search.js";
import { transferInspectEffect, transferListEffect, type TransferResult } from "./transfer.js";

export function transferEnqueueEffect(
  searchId: string,
  candidateId: string,
  yes: unknown,
): Effect.Effect<
  {
    searchId: string;
    candidateId: string;
    existing: boolean;
    transfer: TransferResult;
  },
  RequestFailure,
  SlskdRequest
> {
  return Effect.gen(function* () {
    if (yes !== true)
      return yield* Effect.fail(
        failure("ACKNOWLEDGEMENT_REQUIRED", "This state-changing command requires --yes.", 2),
      );
    const candidate = yield* resolveCandidateEffect(searchId, candidateId);
    searchId = candidate.searchId;
    if (!candidate.username || !candidate.path || candidate.size === null || candidate.isLocked) {
      return yield* Effect.fail(
        failure("INVALID_CANDIDATE", "The selected Candidate cannot be enqueued.", 2),
      );
    }
    const match = (transfer: TransferResult): boolean =>
      transfer.username === candidate.username &&
      transfer.filename === candidate.path &&
      transfer.progress.size === candidate.size;
    const existing = (yield* transferListEffect).find(match);
    if (existing) return { searchId, candidateId, existing: true, transfer: existing };

    const id = deterministicBatchId([searchId, candidateId]);
    let response: unknown;
    let batchExisted = false;
    const posted = yield* Effect.result(
      requestEffect(
        "POST",
        "/transfers/downloads/batches",
        {
          id,
          searchId,
          username: candidate.username,
          files: [{ filename: candidate.path, size: candidate.size }],
        },
        true,
      ),
    );
    if (posted._tag === "Failure") {
      if (!(posted.failure instanceof CoreFailure && posted.failure.status === 409))
        return yield* Effect.fail(posted.failure);
      batchExisted = true;
      response = yield* requestEffect("GET", `/transfers/downloads/batches/${id}`);
    } else response = posted.success;

    const result = response as {
      batch?: { transfers?: Array<{ id?: string; username?: string; filename?: string }> };
      transfers?: Array<{ id?: string; username?: string; filename?: string }>;
      failures?: unknown[];
    } | null;
    if (Array.isArray(result?.failures) && result.failures.length) {
      return yield* Effect.fail(
        failure("REMOTE", "slskd did not enqueue the selected Candidate.", 7),
      );
    }
    const transfers = result?.batch?.transfers ?? result?.transfers ?? [];
    const transfer = transfers.find(
      (item) => item.username === candidate.username && item.filename === candidate.path && item.id,
    );
    if (!transfer?.id) {
      const reconciled = (yield* transferListEffect).find(match);
      if (reconciled)
        return { searchId, candidateId, existing: batchExisted, transfer: reconciled };
      return yield* Effect.fail(
        failure(
          "AMBIGUOUS_MUTATION",
          "slskd accepted the enqueue, but no matching Transfer could be identified. Query slskd before retrying.",
          9,
        ),
      );
    }
    return {
      searchId,
      candidateId,
      existing: batchExisted,
      transfer: yield* transferInspectEffect(candidate.username, transfer.id),
    };
  });
}
