import { CliError, type Context, request, requireYes } from "./core.js";

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

function isNotFound(error: unknown): boolean {
  return error instanceof CliError && error.code === "REMOTE" && error.message.includes("HTTP 404");
}

function missingTransfer(): CliError {
  return new CliError("TRANSFER_NOT_FOUND", "The specified Transfer was not found.", 7);
}

async function getRaw(ctx: Context, username: string, id: string): Promise<unknown> {
  try {
    return await request(ctx, "GET", transferPath(username, id));
  } catch (error) {
    if (isNotFound(error)) throw missingTransfer();
    throw error;
  }
}

/** Get all downloads, flattened from slskd's username/directory response groups. */
export async function transferList(ctx: Context): Promise<TransferResult[]> {
  const raw = await request(ctx, "GET", "/transfers/downloads");
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
}

export async function transferInspect(
  ctx: Context,
  username: string,
  id: string,
): Promise<TransferResult> {
  return normalized(await getRaw(ctx, username, id));
}

export async function transferCancel(
  ctx: Context,
  username: string,
  id: string,
  yes: unknown,
): Promise<{ action: "cancel"; changed: boolean; transfer: TransferResult }> {
  requireYes(yes);
  const current = await transferInspect(ctx, username, id);
  if (current.terminal) return { action: "cancel", changed: false, transfer: current };

  try {
    await request(ctx, "DELETE", `${transferPath(username, id)}?remove=false`, undefined, true);
  } catch (error) {
    if (isNotFound(error)) throw missingTransfer();
    throw error;
  }

  try {
    return { action: "cancel", changed: true, transfer: await transferInspect(ctx, username, id) };
  } catch {
    throw new CliError(
      "AMBIGUOUS_MUTATION",
      "The cancellation request succeeded, but its resulting state could not be read. Query slskd before retrying.",
      9,
    );
  }
}

export async function transferClear(
  ctx: Context,
  yes: unknown,
): Promise<{ action: "clear"; scope: "completed-downloads"; changed: true }> {
  requireYes(yes);
  await request(ctx, "DELETE", "/transfers/downloads/all/completed", undefined, true);
  return { action: "clear", scope: "completed-downloads", changed: true };
}

export async function transferDelete(
  ctx: Context,
  username: string,
  id: string,
  yes: unknown,
): Promise<{ action: "delete"; id: string; username: string; removed: true }> {
  requireYes(yes);
  // Confirm existence first so the API's idempotent remove semantics still report missing records.
  await getRaw(ctx, username, id);
  try {
    await request(ctx, "DELETE", `${transferPath(username, id)}?remove=true`, undefined, true);
  } catch (error) {
    if (isNotFound(error)) throw missingTransfer();
    throw error;
  }
  return { action: "delete", id, username, removed: true };
}
