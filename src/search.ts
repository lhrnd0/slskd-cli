import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import {
  CliError,
  CoreFailure,
  type Context,
  type RequestFailure,
  type SlskdRequest,
  failure,
  requestEffect,
  runOperation,
} from "./core.js";

export const DEFAULT_SEARCH_LIFETIME_SECONDS = 60;
export const MAX_SEARCH_LIFETIME_SECONDS = 300;
export const DEFAULT_POLL_INTERVAL_MS = 1000;
export const DEFAULT_WATCH_TIMEOUT_SECONDS = 300;

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

export function canonicalSearchId(searchId: string): string {
  if (typeof searchId !== "string" || !isUuid(searchId)) {
    throw inputError("searchId must be the UUID returned by slskd search create or search list.");
  }
  return searchId.toLowerCase();
}

/** Keep throwing pure validators at the typed operation boundary. */
function validate<A>(evaluate: () => A): Effect.Effect<A, CoreFailure> {
  return Effect.try({
    try: evaluate,
    catch: (error) =>
      error instanceof CliError
        ? failure(error.code, error.message, error.exitCode)
        : failure("REMOTE", "Unexpected CLI failure.", REMOTE_EXIT),
  });
}

function missingSearchError(): CoreFailure {
  return failure("MISSING_SEARCH", "No Search exists for the supplied searchId.", REMOTE_EXIT);
}

function missingOrExpiredError(search: JsonRecord): CoreFailure {
  const state = String(search.state ?? "").toLowerCase();
  return state.includes("expired")
    ? failure("EXPIRED_SEARCH", "The Search has expired; create a fresh Search.", REMOTE_EXIT)
    : missingSearchError();
}

function mapMissingSearch(error: RequestFailure): RequestFailure {
  return error instanceof CoreFailure && error.status === 404 ? missingSearchError() : error;
}

export function getSearchEffect(
  searchId: string,
): Effect.Effect<JsonRecord, RequestFailure, SlskdRequest> {
  return Effect.gen(function* () {
    const id = yield* validate(() => canonicalSearchId(searchId));
    const value = yield* requestEffect("GET", `searches/${encodeURIComponent(id)}`).pipe(
      Effect.mapError(mapMissingSearch),
    );
    const search = record(value);
    if (!search.id) return yield* Effect.fail(missingOrExpiredError(search));
    if (typeof search.id !== "string" || search.id.toLowerCase() !== id) {
      return yield* Effect.fail(
        failure("REMOTE", "slskd returned a mismatched Search identifier.", REMOTE_EXIT),
      );
    }
    if (
      String(search.state ?? "")
        .toLowerCase()
        .includes("expired")
    ) {
      return yield* Effect.fail(missingOrExpiredError(search));
    }
    return search;
  });
}

/** Start one literal network Search on slskd. 0.26.1 interprets SearchTimeout in milliseconds. */
export function searchCreateEffect(
  query: string,
  lifetimeSeconds = DEFAULT_SEARCH_LIFETIME_SECONDS,
): Effect.Effect<SearchCreated, RequestFailure, SlskdRequest> {
  return Effect.gen(function* () {
    if (typeof query !== "string" || query.trim().length === 0) {
      return yield* Effect.fail(
        failure(
          "INVALID_INPUT",
          "query must contain at least one non-whitespace character.",
          INVALID_INPUT_EXIT,
        ),
      );
    }
    if (
      !Number.isSafeInteger(lifetimeSeconds) ||
      lifetimeSeconds < 5 ||
      lifetimeSeconds > MAX_SEARCH_LIFETIME_SECONDS
    ) {
      return yield* Effect.fail(
        failure(
          "INVALID_INPUT",
          `lifetimeSeconds must be an integer from 5 to ${MAX_SEARCH_LIFETIME_SECONDS}.`,
          INVALID_INPUT_EXIT,
        ),
      );
    }
    const search = record(
      yield* requestEffect(
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
      return yield* Effect.fail(
        failure("REMOTE", "slskd returned an invalid Search identifier.", REMOTE_EXIT),
      );
    }
    return { searchId: id, lifetimeSeconds };
  });
}

function searchSummaries(value: unknown) {
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

/** List Search summaries using the same identifiers as create, candidates and enqueue. */
export const searchListEffect: Effect.Effect<
  ReturnType<typeof searchSummaries>,
  RequestFailure,
  SlskdRequest
> = Effect.flatMap(requestEffect("GET", "searches"), (value) =>
  validate(() => searchSummaries(value)),
);

export function searchDeleteEffect(
  searchId: string,
): Effect.Effect<{ searchId: string; deleted: true }, RequestFailure, SlskdRequest> {
  return Effect.gen(function* () {
    const id = yield* validate(() => canonicalSearchId(searchId));
    yield* requestEffect("DELETE", `searches/${encodeURIComponent(id)}`, undefined, true).pipe(
      Effect.mapError(mapMissingSearch),
    );
    return { searchId: id, deleted: true as const };
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

export function searchCandidatesEffect(
  searchId: string,
): Effect.Effect<Candidate[], RequestFailure, SlskdRequest> {
  return Effect.gen(function* () {
    const search = yield* getSearchEffect(searchId);
    const id = (search.id as string).toLowerCase();
    const responses = yield* requestEffect("GET", `searches/${encodeURIComponent(id)}/responses`);
    return yield* validate(() => candidatesFromResponses(id, responses));
  });
}

/** Temporary adapters for enqueue and Search watches awaiting migration. */
export function searchCandidates(ctx: Context, searchId: string): Promise<Candidate[]> {
  return runOperation(ctx, searchCandidatesEffect(searchId));
}

function getSearch(ctx: Context, searchId: string): Promise<JsonRecord> {
  return runOperation(ctx, getSearchEffect(searchId));
}

export type SearchWatchEvent =
  | { event: "started"; searchId: string }
  | {
      event: "progress";
      searchId: string;
      state: string;
      responseCount: number | null;
      fileCount: number | null;
      lockedFileCount: number | null;
    }
  | { event: "candidate"; searchId: string; candidate: Candidate }
  | {
      event: "ended";
      searchId: string;
      reason: "completed" | "deadline";
      candidateCount: number;
    };

export type SearchWatchOptions = {
  pollIntervalMs?: number;
  watchTimeoutSeconds?: number;
};

export function resolveSearchWatchOptions(options: SearchWatchOptions = {}): {
  pollIntervalMs: number;
  watchTimeoutSeconds: number;
} {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const watchTimeoutSeconds = options.watchTimeoutSeconds ?? DEFAULT_WATCH_TIMEOUT_SECONDS;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000) {
    throw inputError("pollIntervalMs must be an integer from 100 to 60000.");
  }
  if (
    !Number.isSafeInteger(watchTimeoutSeconds) ||
    watchTimeoutSeconds < 1 ||
    watchTimeoutSeconds > 3600
  ) {
    throw inputError("watchTimeoutSeconds must be an integer from 1 to 3600.");
  }

  return { pollIntervalMs, watchTimeoutSeconds };
}

function waitForPoll(intervalMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, intervalMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function collectionCompleted(search: JsonRecord): boolean {
  if (typeof search.state !== "string" || search.state.trim().length === 0) {
    throw new CliError("REMOTE", "slskd returned an invalid Search state.", REMOTE_EXIT);
  }
  // Soulseek.NET SearchStates is a flags enum, serialized by slskd as names.
  return search.state.split(",").some((state) => state.trim().toLowerCase() === "completed");
}

/** Observe only slskd-owned Search state; replay and deduplication are scoped to this invocation. */
export async function* searchWatch(
  ctx: Context,
  searchId: string,
  options: SearchWatchOptions = {},
): AsyncGenerator<SearchWatchEvent> {
  searchId = canonicalSearchId(searchId);
  const { pollIntervalMs, watchTimeoutSeconds } = resolveSearchWatchOptions(options);

  const controller = new AbortController();
  const deadline = new Error("Search observation deadline reached.");
  const abort = () => controller.abort(ctx.signal?.reason);
  ctx.signal?.addEventListener("abort", abort, { once: true });
  if (ctx.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(deadline), watchTimeoutSeconds * 1000);
  const watchCtx = { ...ctx, signal: controller.signal };
  const emitted = new Set<string>();
  try {
    let search = await getSearch(watchCtx, searchId);
    // Validate state before advertising successful attachment.
    collectionCompleted(search);
    controller.signal.throwIfAborted();
    yield { event: "started", searchId };
    while (true) {
      controller.signal.throwIfAborted();
      const completed = collectionCompleted(search);
      yield {
        event: "progress",
        searchId,
        state: search.state as string,
        responseCount: numberOrNull(search.responseCount),
        fileCount: numberOrNull(search.fileCount),
        lockedFileCount: numberOrNull(search.lockedFileCount),
      };
      const responses = await runOperation(
        watchCtx,
        requestEffect("GET", `searches/${encodeURIComponent(searchId)}/responses`).pipe(
          Effect.mapError(mapMissingSearch),
        ),
      );
      for (const candidate of candidatesFromResponses(searchId, responses)) {
        controller.signal.throwIfAborted();
        if (emitted.has(candidate.candidateId)) continue;
        emitted.add(candidate.candidateId);
        yield { event: "candidate", searchId, candidate };
      }
      controller.signal.throwIfAborted();
      if (completed) {
        yield { event: "ended", searchId, reason: "completed", candidateCount: emitted.size };
        return;
      }
      await waitForPoll(pollIntervalMs, controller.signal);
      search = await getSearch(watchCtx, searchId);
    }
  } catch (error) {
    if (error !== deadline) throw error;
    yield { event: "ended", searchId, reason: "deadline", candidateCount: emitted.size };
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", abort);
  }
}

/** Resolve a scoped candidate ID by re-reading slskd, keeping IDs stateless and deterministic. */
export function resolveCandidateEffect(
  searchId: string,
  candidateId: string,
): Effect.Effect<Candidate, RequestFailure, SlskdRequest> {
  return Effect.gen(function* () {
    if (typeof candidateId !== "string" || !/^cand_[A-Za-z0-9_-]{22}$/.test(candidateId)) {
      return yield* Effect.fail(
        failure("INVALID_INPUT", "candidateId is invalid.", INVALID_INPUT_EXIT),
      );
    }
    const candidates = yield* searchCandidatesEffect(searchId);
    const candidate = candidates.find((item) => item.candidateId === candidateId);
    if (!candidate) {
      return yield* Effect.fail(
        failure(
          "MISSING_CANDIDATE",
          "No Candidate exists with that ID in this Search.",
          REMOTE_EXIT,
        ),
      );
    }
    return candidate;
  });
}

export function resolveCandidate(
  ctx: Context,
  searchId: string,
  candidateId: string,
): Promise<Candidate> {
  return runOperation(ctx, resolveCandidateEffect(searchId, candidateId));
}
