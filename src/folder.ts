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
  requireYes,
  runOperation,
} from "./core.js";
import { resolveCandidateEffect, type Candidate } from "./search.js";

const REMOTE_EXIT = 7;
type RecordValue = Record<string, unknown>;
export type FolderFile = {
  fileId: string;
  path: string;
  filename: string;
  size: number | null;
  extension: string | null;
  bitRate: number | null;
  length: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  isVariableBitRate: boolean | null;
  isLocked: boolean | null;
  eligible: boolean;
  ineligibleReason: string | null;
};
export type FolderListing = {
  folderRef: string;
  username: string;
  directory: string;
  files: FolderFile[];
};

function obj(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}
function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f;
  });
}
function fail(message: string): CliError {
  return new CliError("INVALID_INPUT", message, 2);
}
function remote(message: string): CliError {
  return new CliError("REMOTE", message, REMOTE_EXIT);
}
function folderRef(username: string, directory: string): string {
  return `folder_${Buffer.from(JSON.stringify([username, directory])).toString("base64url")}`;
}
function decodeFolderRef(ref: string): [string, string] {
  if (typeof ref !== "string" || !/^folder_[A-Za-z0-9_-]+$/.test(ref))
    throw fail("folderRef is invalid.");
  let value: unknown;
  try {
    const encoded = ref.slice(7);
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error();
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw fail("folderRef is invalid.");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some((part) => typeof part !== "string" || !part.trim() || hasControlCharacters(part)) ||
    /(?:^|[\\/])\.\.?(?:[\\/]|$)/.test(value[1] as string) ||
    folderRef(value[0] as string, value[1] as string) !== ref
  )
    throw fail("folderRef is invalid.");
  return value as [string, string];
}
function fileId(username: string, directory: string, path: string, size: number | null): string {
  return `file_${createHash("sha256")
    .update(JSON.stringify([username, directory, path, size]))
    .digest("base64url")}`;
}

function validate<A>(evaluate: () => A): Effect.Effect<A, CoreFailure> {
  return Effect.try({
    try: evaluate,
    catch: (error) =>
      error instanceof CliError
        ? failure(error.code, error.message, error.exitCode)
        : failure("REMOTE", "Unexpected CLI failure.", REMOTE_EXIT),
  });
}

function listingEffect(
  username: string,
  directory: string,
): Effect.Effect<FolderListing, RequestFailure, SlskdRequest> {
  return Effect.gen(function* () {
    const value = yield* requestEffect("POST", `users/${encodeURIComponent(username)}/directory`, {
      directory,
    }).pipe(
      Effect.mapError((error) =>
        error instanceof CoreFailure && error.status === 404
          ? failure("UNAVAILABLE_FOLDER", "The peer folder is unavailable.", REMOTE_EXIT)
          : error,
      ),
    );
    return yield* validate(() => normalizeListing(username, directory, value));
  });
}

function normalizeListing(username: string, directory: string, value: unknown): FolderListing {
  if (!Array.isArray(value)) throw remote("slskd returned an incomplete folder listing.");
  // The endpoint returns directories; only the requested immediate directory is in scope.
  const wanted = directory;
  const dirs = value.map(obj);
  const matches = dirs.filter((entry) => entry && entry.name === wanted);
  if (matches.length > 1) throw remote("slskd returned an ambiguous folder listing.");
  const selected = matches[0];
  if (!selected)
    throw new CliError(
      "UNAVAILABLE_FOLDER",
      "The requested peer folder was not returned.",
      REMOTE_EXIT,
    );
  if (!Array.isArray(selected.files)) throw remote("slskd returned an incomplete folder listing.");
  const names = new Set<string>();
  for (const raw of selected.files) {
    const file = obj(raw);
    const name = file && str(file.filename);
    if (name !== null && names.has(name))
      throw remote("slskd returned duplicate filenames in the folder listing.");
    if (name !== null) names.add(name);
  }
  const files: FolderFile[] = selected.files.map((raw: unknown) => {
    const f = obj(raw) ?? {};
    const filename = str(f.filename) ?? "";
    const size =
      typeof f.size === "number" && Number.isSafeInteger(f.size) && f.size >= 0 ? f.size : null;
    const extension = str(f.extension);
    const nested = /[\\/]/.test(filename);
    const path = nested
      ? `${wanted}\\${filename}`
      : `${wanted}${wanted.endsWith("\\") || wanted.endsWith("/") ? "" : "\\"}${filename}`;
    const locked = bool(f.isLocked) ?? bool(f.locked);
    const reason =
      !filename.trim() || filename === "." || filename === ".." || hasControlCharacters(filename)
        ? "invalid filename"
        : nested
          ? "file is outside the immediate directory"
          : size === null
            ? "invalid size"
            : locked === true
              ? "locked"
              : null;
    return {
      fileId: fileId(username, wanted, path, size),
      path,
      filename: filename.split(/[\\/]/).pop() ?? filename,
      size,
      extension,
      bitRate: num(f.bitRate),
      length: num(f.length),
      sampleRate: num(f.sampleRate),
      bitDepth: num(f.bitDepth),
      isVariableBitRate: bool(f.isVariableBitRate),
      isLocked: locked,
      eligible: reason === null,
      ineligibleReason: reason,
    };
  });
  return { folderRef: folderRef(username, wanted), username, directory: wanted, files };
}

function candidateDirectory(candidate: Candidate): { username: string; directory: string } {
  if (
    !candidate.username?.trim() ||
    hasControlCharacters(candidate.username) ||
    !candidate.path ||
    /[\\/]$/.test(candidate.path) ||
    hasControlCharacters(candidate.path)
  )
    throw fail("Candidate does not identify a usable remote file.");
  const i = Math.max(candidate.path.lastIndexOf("\\"), candidate.path.lastIndexOf("/"));
  if (i <= 0) throw fail("Candidate does not identify a usable remote directory.");
  const directory = candidate.path.slice(0, i);
  if (!directory.trim() || /(?:^|[\\/])\.\.?(?:[\\/]|$)/.test(directory))
    throw fail("Candidate does not identify a usable remote directory.");
  return { username: candidate.username, directory };
}

export function folderDiscoverEffect(
  searchId: string,
  candidateId: string,
  yes: unknown,
): Effect.Effect<FolderListing, RequestFailure, SlskdRequest> {
  return Effect.gen(function* () {
    yield* validate(() => requireYes(yes));
    const candidate = yield* resolveCandidateEffect(searchId, candidateId);
    const { username, directory } = yield* validate(() => candidateDirectory(candidate));
    return yield* listingEffect(username, directory);
  });
}

export function folderShowEffect(
  folderReference: string,
  yes: unknown,
): Effect.Effect<FolderListing, RequestFailure, SlskdRequest> {
  return Effect.gen(function* () {
    yield* validate(() => requireYes(yes));
    const [username, directory] = yield* validate(() => decodeFolderRef(folderReference));
    return yield* listingEffect(username, directory);
  });
}

/** Temporary adapter for folder enqueue awaiting migration. */
export function folderShow(
  ctx: Context,
  folderReference: string,
  yes: unknown,
): Promise<FolderListing> {
  return runOperation(ctx, folderShowEffect(folderReference, yes));
}
