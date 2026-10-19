import { createHash } from "node:crypto";
import { CliError, type Context, request } from "./core.js";

export const DEFAULT_SEARCH_LIFETIME_SECONDS = 60;
export const MAX_SEARCH_LIFETIME_SECONDS = 300;

const INVALID_INPUT_EXIT = 2;
const REMOTE_EXIT = 7;

type JsonRecord = Record<string, unknown>;

export type SearchCreated = {
  searchId: string;
  lifetimeSeconds: number;
};

export type Candidate = {
  candidateId: string;
  /** The canonical slskd Search UUID, shared by all CLI commands. */
  searchId: string;
  username: string | null;
  path: string | null;
  filename: string | null;
  extension: string | null;
  size: number | null;
  queueLength: number | null;
  hasFreeUploadSlot: boolean | null;
  uploadSpeed: number | null;
  bitRate: number | null;
  length: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  isVariableBitRate: boolean | null;
  isLocked: boolean | null;
};

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function inputError(message: string): CliError {
  return new CliError("INVALID_INPUT", message, INVALID_INPUT_EXIT);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function errorForMissingOrExpired(search: JsonRecord): never {
  const state = String(search.state ?? "").toLowerCase();
  const code = state.includes("expired") ? "EXPIRED_SEARCH" : "MISSING_SEARCH";
  const message =
    code === "EXPIRED_SEARCH"
      ? "The Search has expired; create a fresh Search."
      : "No Search exists for the supplied searchId.";
  throw new CliError(code, message, REMOTE_EXIT);
}

async function getSearch(ctx: Context, searchId: string): Promise<JsonRecord> {
  if (typeof searchId !== "string" || !isUuid(searchId)) {
    throw inputError("searchId must be the UUID returned by slskd search create or search list.");
  }
  let value: unknown;
  try {
    value = await request(ctx, "GET", `searches/${encodeURIComponent(searchId)}`);
  } catch (error) {
    if (
      error instanceof CliError &&
      error.code === "REMOTE" &&
      error.message.includes("HTTP 404")
    ) {
      throw new CliError(
        "MISSING_SEARCH",
        "No Search exists for the supplied searchId.",
        REMOTE_EXIT,
      );
    }
    throw error;
  }
  const search = record(value);
  if (!search.id) errorForMissingOrExpired(search);
  if (typeof search.id !== "string" || search.id.toLowerCase() !== searchId.toLowerCase()) {
    throw new CliError("REMOTE", "slskd returned a mismatched Search identifier.", REMOTE_EXIT);
  }
  if (
    String(search.state ?? "")
      .toLowerCase()
      .includes("expired")
  ) {
    errorForMissingOrExpired(search);
  }
  return search;
}

/** Start one literal network Search on slskd. 0.26.1 interprets SearchTimeout in milliseconds. */
export async function searchCreate(
  ctx: Context,
  query: string,
  lifetimeSeconds = DEFAULT_SEARCH_LIFETIME_SECONDS,
): Promise<SearchCreated> {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw inputError("query must contain at least one non-whitespace character.");
  }
  if (
    !Number.isSafeInteger(lifetimeSeconds) ||
    lifetimeSeconds < 5 ||
    lifetimeSeconds > MAX_SEARCH_LIFETIME_SECONDS
  ) {
    throw inputError(
      `lifetimeSeconds must be an integer from 5 to ${MAX_SEARCH_LIFETIME_SECONDS}.`,
    );
  }

  const search = record(
    await request(
      ctx,
      "POST",
      "searches",
      {
        searchText: query,
        searchTimeout: lifetimeSeconds * 1000,
      },
      true,
    ),
  );
  const id = stringOrNull(search.id);
  if (!id || !isUuid(id)) {
    throw new CliError("REMOTE", "slskd returned an invalid Search identifier.", REMOTE_EXIT);
  }
  return {
    searchId: id,
    lifetimeSeconds,
  };
}

/** List Search summaries using the same identifiers as create, candidates and enqueue. */
export async function searchList(ctx: Context) {
  const value = await request(ctx, "GET", "searches");
  if (!Array.isArray(value)) {
    throw new CliError("REMOTE", "slskd returned an invalid Search list.", REMOTE_EXIT);
  }
  return value.map((item: unknown) => {
    const search = record(item);
    const id = stringOrNull(search.id);
    if (!id || !isUuid(id)) {
      throw new CliError("REMOTE", "slskd returned an invalid Search identifier.", REMOTE_EXIT);
    }
    return {
      searchId: id,
      query: stringOrNull(search.searchText),
      state: stringOrNull(search.state),
      startedAt: stringOrNull(search.startedAt),
      endedAt: stringOrNull(search.endedAt),
      responseCount: numberOrNull(search.responseCount),
      fileCount: numberOrNull(search.fileCount),
      lockedFileCount: numberOrNull(search.lockedFileCount),
    };
  });
}

function makeCandidateId(
  searchId: string,
  username: string | null,
  filename: string | null,
  size: number | null,
): string {
  const scope = JSON.stringify([searchId, username, filename, size]);
  return `cand_${createHash("sha256").update(scope).digest("base64url").slice(0, 22)}`;
}

function candidatesFromResponses(searchId: string, value: unknown): Candidate[] {
  if (!Array.isArray(value)) {
    throw new CliError("REMOTE", "slskd returned an invalid Search response list.", REMOTE_EXIT);
  }
  const candidates: Candidate[] = [];
  for (const rawResponse of value) {
    const response = record(rawResponse);
    const username = stringOrNull(response.username);
    for (const [key, locked] of [
      ["files", false],
      ["lockedFiles", true],
    ] as const) {
      const files = Array.isArray(response[key]) ? (response[key] as unknown[]) : [];
      for (const rawFile of files) {
        const file = record(rawFile);
        const path = stringOrNull(file.filename);
        const extension = stringOrNull(file.extension);
        const size = numberOrNull(file.size);
        const isLocked = boolOrNull(file.isLocked) ?? locked;
        candidates.push({
          candidateId: makeCandidateId(searchId, username, path, size),
          searchId,
          username,
          path,
          filename: path === null ? null : (path.split(/[\\/]/).pop() ?? null),
          extension,
          size,
          queueLength: numberOrNull(response.queueLength),
          hasFreeUploadSlot: boolOrNull(response.hasFreeUploadSlot),
          uploadSpeed: numberOrNull(response.uploadSpeed),
          bitRate: numberOrNull(file.bitRate),
          length: numberOrNull(file.length),
          sampleRate: numberOrNull(file.sampleRate),
          bitDepth: numberOrNull(file.bitDepth),
          isVariableBitRate: boolOrNull(file.isVariableBitRate),
          isLocked,
        });
      }
    }
  }
  return candidates;
}

export async function searchCandidates(ctx: Context, searchId: string): Promise<Candidate[]> {
  const search = await getSearch(ctx, searchId);
  const id = (search.id as string).toLowerCase();
  const responses = await request(ctx, "GET", `searches/${encodeURIComponent(id)}/responses`);
  return candidatesFromResponses(id, responses);
}

/** Resolve a scoped candidate ID by re-reading slskd, keeping IDs stateless and deterministic. */
export async function resolveCandidate(
  ctx: Context,
  searchId: string,
  candidateId: string,
): Promise<Candidate> {
  if (typeof candidateId !== "string" || !/^cand_[A-Za-z0-9_-]{22}$/.test(candidateId)) {
    throw inputError("candidateId is invalid.");
  }
  const candidates = await searchCandidates(ctx, searchId);
  const candidate = candidates.find((item) => item.candidateId === candidateId);
  if (!candidate) {
    throw new CliError(
      "MISSING_CANDIDATE",
      "No Candidate exists with that ID in this Search.",
      REMOTE_EXIT,
    );
  }
  return candidate;
}
