import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { CliError, type Context, request } from "./core.js";

export const DEFAULT_SEARCH_LIFETIME_SECONDS = 60;
export const MAX_SEARCH_LIFETIME_SECONDS = 300;

const INVALID_INPUT_EXIT = 2;
const REMOTE_EXIT = 7;

type JsonRecord = Record<string, unknown>;

export type SearchCreated = {
  searchId: string;
  lifetimeSeconds: number;
  expiresAt: string;
};

export type Candidate = {
  candidateId: string;
  /** Opaque client Search reference, suitable for use by subsequent CLI commands. */
  searchId: string;
  /** The upstream slskd UUID, required when building its transfer enqueue payload. */
  slskdSearchId: string;
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type SearchReference = { id: string; expiresAt: number };

export function decodeSearchRef(ctx: Context, searchRef: string): SearchReference {
  try {
    const [data, signature, extra] = searchRef.split(".");
    if (!data || !signature || extra) throw new Error("invalid token");
    const expected = createHmac("sha256", ctx.apiKey).update(data).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error("invalid signature");
    const parsed = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as JsonRecord;
    if (
      typeof parsed.id === "string" &&
      isUuid(parsed.id) &&
      typeof parsed.expiresAt === "number" &&
      Number.isSafeInteger(parsed.expiresAt)
    ) {
      return { id: parsed.id, expiresAt: parsed.expiresAt };
    }
  } catch {
    /* handled below */
  }
  throw inputError("searchId must be an opaque Search reference returned by search create.");
}

function encodeSearchRef(ctx: Context, id: string, expiresAt: number): string {
  const data = Buffer.from(JSON.stringify({ id, expiresAt }), "utf8").toString("base64url");
  const signature = createHmac("sha256", ctx.apiKey).update(data).digest("base64url");
  return `${data}.${signature}`;
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

async function getSearch(
  ctx: Context,
  searchId: string,
): Promise<{ search: JsonRecord; reference: SearchReference }> {
  const reference = decodeSearchRef(ctx, searchId);
  if (Date.now() >= reference.expiresAt) {
    throw new CliError(
      "EXPIRED_SEARCH",
      "The Search has expired; create a fresh Search.",
      REMOTE_EXIT,
    );
  }
  let value: unknown;
  try {
    value = await request(ctx, "GET", `searches/${encodeURIComponent(reference.id)}`);
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
  return { search, reference };
}

function assertSearchFresh(search: JsonRecord, reference: SearchReference): void {
  const startedAt = parseTimestamp(search.startedAt);
  if (startedAt === null) {
    throw new CliError(
      "REMOTE",
      "slskd returned a Search without a valid startedAt timestamp.",
      REMOTE_EXIT,
    );
  }
  if (reference.expiresAt > startedAt + MAX_SEARCH_LIFETIME_SECONDS * 1000) {
    throw inputError("searchId is not a valid Search reference.");
  }
  if (Date.now() >= Math.min(reference.expiresAt, startedAt + MAX_SEARCH_LIFETIME_SECONDS * 1000)) {
    throw new CliError(
      "EXPIRED_SEARCH",
      "The Search has expired; create a fresh Search.",
      REMOTE_EXIT,
    );
  }
  const state = String(search.state ?? "").toLowerCase();
  if (state.includes("expired")) errorForMissingOrExpired(search);
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
  const startedAt = parseTimestamp(search.startedAt);
  if (!id || !isUuid(id) || startedAt === null) {
    throw new CliError(
      "REMOTE",
      "slskd returned an invalid Search identifier or startedAt timestamp.",
      REMOTE_EXIT,
    );
  }
  return {
    searchId: encodeSearchRef(ctx, id, startedAt + lifetimeSeconds * 1000),
    lifetimeSeconds,
    expiresAt: new Date(startedAt + lifetimeSeconds * 1000).toISOString(),
  };
}

/** List upstream Search summaries without reconstructing bounded client references. */
export async function searchList(ctx: Context) {
  const value = await request(ctx, "GET", "searches");
  if (!Array.isArray(value)) {
    throw new CliError("REMOTE", "slskd returned an invalid Search list.", REMOTE_EXIT);
  }
  return value.map((item: unknown) => {
    const search = record(item);
    const id = stringOrNull(search.id);
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new CliError("REMOTE", "slskd returned an invalid Search identifier.", REMOTE_EXIT);
    }
    return {
      slskdSearchId: id,
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

function candidatesFromResponses(searchRef: string, searchId: string, value: unknown): Candidate[] {
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
          searchId: searchRef,
          slskdSearchId: searchId,
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
  const { search, reference } = await getSearch(ctx, searchId);
  assertSearchFresh(search, reference);
  const responses = await request(
    ctx,
    "GET",
    `searches/${encodeURIComponent(reference.id)}/responses`,
  );
  return candidatesFromResponses(searchId, reference.id, responses);
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
