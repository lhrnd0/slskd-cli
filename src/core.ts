import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

export type Context = { baseUrl: string; apiKey: string; timeoutMs: number };

const EXIT = {
  INVALID_INPUT: 2,
  MISSING_CONFIGURATION: 3,
  AUTHENTICATION: 4,
  INCOMPATIBLE: 5,
  CONNECTION: 6,
  REMOTE: 7,
  TIMEOUT: 8,
  AMBIGUOUS_MUTATION: 9,
} as const;

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode: number = EXIT.REMOTE) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

type ConfigValues = { baseUrl?: unknown; apiKey?: unknown; timeoutMs?: unknown };
type Flags = Record<string, unknown>;

function configPath(env: NodeJS.ProcessEnv): string {
  return (
    env.SLSKD_CLI_CONFIG ||
    join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "slskd-cli", "config.toml")
  );
}

function configValues(env: NodeJS.ProcessEnv): ConfigValues {
  let raw: string;
  try {
    raw = readFileSync(configPath(env), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new CliError(
      "INVALID_CONFIG",
      "Could not read the connection profile.",
      EXIT.INVALID_INPUT,
    );
  }
  try {
    const parsed = parseToml(raw) as Record<string, unknown>;
    const section = (parsed.connection ?? parsed) as ConfigValues;
    if (!section || typeof section !== "object" || Array.isArray(section))
      throw new Error("invalid section");
    return section;
  } catch {
    throw new CliError(
      "INVALID_CONFIG",
      "The connection profile is not valid TOML.",
      EXIT.INVALID_INPUT,
    );
  }
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function timeoutValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 2_147_483_647) {
    throw new CliError(
      "INVALID_INPUT",
      "timeoutMs must be a positive integer.",
      EXIT.INVALID_INPUT,
    );
  }
  return n;
}

/** Resolve one connection profile, then environment, then explicit command flags. */
export function resolveContext(flags: Flags = {}, env: NodeJS.ProcessEnv = process.env): Context {
  const file = configValues(env);
  const baseUrl =
    scalar(flags.baseUrl ?? flags["base-url"]) ??
    scalar(env.SLSKD_BASE_URL) ??
    scalar(file.baseUrl);
  const apiKey =
    scalar(flags.apiKey ?? flags["api-key"]) ?? scalar(env.SLSKD_API_KEY) ?? scalar(file.apiKey);
  const timeoutMs =
    timeoutValue(flags.timeoutMs ?? flags["timeout-ms"]) ??
    timeoutValue(env.SLSKD_TIMEOUT_MS) ??
    timeoutValue(file.timeoutMs) ??
    30_000;

  if (!baseUrl || !apiKey) {
    throw new CliError(
      "MISSING_CONFIGURATION",
      "Configure baseUrl and apiKey in the connection profile, environment, or flags.",
      EXIT.MISSING_CONFIGURATION,
    );
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new CliError(
      "INVALID_INPUT",
      "baseUrl must be an absolute HTTP or HTTPS URL.",
      EXIT.INVALID_INPUT,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError("INVALID_INPUT", "baseUrl must use HTTP or HTTPS.", EXIT.INVALID_INPUT);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CliError(
      "INVALID_INPUT",
      "baseUrl cannot contain credentials, a query, or a fragment.",
      EXIT.INVALID_INPUT,
    );
  }
  return { baseUrl: url.toString().replace(/\/$/, ""), apiKey, timeoutMs };
}

function safeMessage(ctx: Context, message: string): string {
  return message.split(ctx.apiKey).join("[redacted]");
}

/** Make an authenticated API request; paths may be relative to /api/v0 or include that prefix. */
export async function request(
  ctx: Context,
  method: string,
  path: string,
  body?: unknown,
  mutation = false,
): Promise<unknown> {
  const cleanPath = path.replace(/^\/+/, "");
  const apiPath = cleanPath.startsWith("api/v0/") ? cleanPath : `api/v0/${cleanPath}`;
  let url: URL;
  try {
    url = new URL(`${ctx.baseUrl}/${apiPath}`);
  } catch {
    throw new CliError("INVALID_INPUT", "Invalid API request path.", EXIT.INVALID_INPUT);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: method.toUpperCase(),
        headers: {
          "X-API-Key": ctx.apiKey,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          Accept: "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        if (mutation)
          throw new CliError(
            "AMBIGUOUS_MUTATION",
            "The mutation timed out with an unknown outcome; query slskd before retrying.",
            EXIT.AMBIGUOUS_MUTATION,
          );
        throw new CliError("TIMEOUT", `Request timed out after ${ctx.timeoutMs} ms.`, EXIT.TIMEOUT);
      }
      // A mutation with unknown delivery must be reconciled by querying slskd before retrying.
      if (mutation) {
        throw new CliError(
          "AMBIGUOUS_MUTATION",
          "The mutation outcome is unknown; query slskd before retrying.",
          EXIT.AMBIGUOUS_MUTATION,
        );
      }
      const detail = error instanceof Error ? safeMessage(ctx, error.message) : "network error";
      throw new CliError("CONNECTION", `Could not connect to slskd: ${detail}`, EXIT.CONNECTION);
    }
    if (response.status === 401 || response.status === 403) {
      throw new CliError(
        "AUTHENTICATION",
        "slskd rejected the API key or its permissions.",
        EXIT.AUTHENTICATION,
      );
    }
    if (!response.ok) {
      throw new CliError("REMOTE", `slskd returned HTTP ${response.status}.`, EXIT.REMOTE);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      if (mutation)
        throw new CliError(
          "AMBIGUOUS_MUTATION",
          "slskd accepted the mutation but returned invalid JSON; query slskd before retrying.",
          EXIT.AMBIGUOUS_MUTATION,
        );
      throw new CliError("REMOTE", "slskd returned invalid JSON.", EXIT.REMOTE);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (controller.signal.aborted) {
      if (mutation)
        throw new CliError(
          "AMBIGUOUS_MUTATION",
          "The mutation timed out with an unknown outcome; query slskd before retrying.",
          EXIT.AMBIGUOUS_MUTATION,
        );
      throw new CliError("TIMEOUT", `Request timed out after ${ctx.timeoutMs} ms.`, EXIT.TIMEOUT);
    }
    if (mutation)
      throw new CliError(
        "AMBIGUOUS_MUTATION",
        "The mutation response was interrupted; query slskd before retrying.",
        EXIT.AMBIGUOUS_MUTATION,
      );
    throw new CliError("REMOTE", "Could not read the slskd response.", EXIT.REMOTE);
  } finally {
    clearTimeout(timer);
  }
}

function versionFrom(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["version", "currentVersion", "applicationVersion"]) {
      if (typeof record[key] === "string") return record[key];
    }
  }
  return undefined;
}

function compareVersion(actual: string, minimum: string): number | undefined {
  const parse = (s: string): number[] | undefined => {
    const match = s.trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\+.*)?$/);
    return match
      ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)]
      : undefined;
  };
  const a = parse(actual);
  const b = parse(minimum);
  if (!a || !b) return undefined;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

/** Verify authentication and the minimum supported version (0.26.1). */
export async function compatible(
  ctx: Context,
): Promise<{ compatible: true; version: string; apiKeyRole: "unverified" }> {
  const raw = await request(ctx, "GET", "/application/version");
  const version = versionFrom(raw);
  if (!version)
    throw new CliError(
      "INCOMPATIBLE",
      "slskd did not return a recognizable application version.",
      EXIT.INCOMPATIBLE,
    );
  const comparison = compareVersion(version, "0.26.1");
  if (comparison === undefined || comparison < 0) {
    throw new CliError(
      "INCOMPATIBLE",
      `slskd ${version} is unsupported; version 0.26.1 or later is required.`,
      EXIT.INCOMPATIBLE,
    );
  }
  return { compatible: true, version, apiKeyRole: "unverified" };
}

export function requireYes(yes: unknown): void {
  if (yes !== true)
    throw new CliError(
      "ACKNOWLEDGEMENT_REQUIRED",
      "This state-changing command requires --yes.",
      EXIT.INVALID_INPUT,
    );
}
