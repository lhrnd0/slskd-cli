import { deterministicBatchId } from "./batch.js";
import { CliError, type Context, request, requireYes } from "./core.js";
import { resolveCandidate } from "./search.js";
import { transferInspect, transferList, type TransferResult } from "./transfer.js";

export async function transferEnqueue(
  ctx: Context,
  searchId: string,
  candidateId: string,
  yes: unknown,
): Promise<{
  searchId: string;
  candidateId: string;
  existing: boolean;
  transfer: TransferResult;
}> {
  requireYes(yes);
  const candidate = await resolveCandidate(ctx, searchId, candidateId);
  searchId = candidate.searchId;
  if (!candidate.username || !candidate.path || candidate.size === null || candidate.isLocked) {
    throw new CliError("INVALID_CANDIDATE", "The selected Candidate cannot be enqueued.", 2);
  }
  const match = (transfer: TransferResult): boolean =>
    transfer.username === candidate.username &&
    transfer.filename === candidate.path &&
    transfer.progress.size === candidate.size;
  const existing = (await transferList(ctx)).find(match);
  if (existing) return { searchId, candidateId, existing: true, transfer: existing };

  const id = deterministicBatchId([searchId, candidateId]);
  let response: unknown;
  try {
    response = await request(
      ctx,
      "POST",
      "/transfers/downloads/batches",
      {
        id,
        searchId,
        username: candidate.username,
        files: [{ filename: candidate.path, size: candidate.size }],
      },
      true,
    );
  } catch (error) {
    if (
      !(error instanceof CliError && error.code === "REMOTE" && error.message.includes("HTTP 409"))
    )
      throw error;
    response = await request(ctx, "GET", `/transfers/downloads/batches/${id}`);
  }

  const result = response as {
    batch?: { transfers?: Array<{ id?: string; username?: string; filename?: string }> };
    transfers?: Array<{ id?: string; username?: string; filename?: string }>;
    failures?: unknown[];
  } | null;
  if (Array.isArray(result?.failures) && result.failures.length) {
    throw new CliError("REMOTE", "slskd did not enqueue the selected Candidate.", 7);
  }
  const transfers = result?.batch?.transfers ?? result?.transfers ?? [];
  const transfer = transfers.find(
    (item) => item.username === candidate.username && item.filename === candidate.path && item.id,
  );
  if (!transfer?.id) {
    const reconciled = (await transferList(ctx)).find(match);
    if (reconciled) return { searchId, candidateId, existing: false, transfer: reconciled };
    throw new CliError(
      "AMBIGUOUS_MUTATION",
      "slskd accepted the enqueue, but no matching Transfer could be identified. Query slskd before retrying.",
      9,
    );
  }
  return {
    searchId,
    candidateId,
    existing: false,
    transfer: await transferInspect(ctx, candidate.username, transfer.id),
  };
}
