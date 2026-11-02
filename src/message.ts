import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CliError, type Context, request, requestWithStatus, requireYes } from "./core.js";

export type PrivateMessage = {
  messageId: string;
  serverId: number;
  username: string;
  timestamp: string;
  direction: "incoming" | "outgoing";
  text: string;
  isAcknowledged: boolean;
  wasReplayed: boolean | null;
};

export type Conversation = {
  username: string;
  isActive: boolean | null;
  unacknowledgedMessageCount: number;
};

// This is an upstream API window, not a CLI pagination limit or a completeness claim.
const HISTORY = { limit: 100, complete: false, lossless: false } as const;

function input(message: string): CliError {
  return new CliError("INVALID_INPUT", message, 2);
}

function remote(message = "slskd returned invalid messaging data."): CliError {
  return new CliError("REMOTE", message, 7);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw remote();
  return value as Record<string, unknown>;
}

export function messageUsername(value: string): string {
  if (
    !value ||
    !value.trim() ||
    value === "." ||
    value === ".." ||
    [...value].some(
      (character) => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127,
    )
  )
    throw input("A non-empty Soulseek username without control characters is required.");
  return value;
}

function pathFor(username: string): string {
  return `conversations/${encodeURIComponent(messageUsername(username))}`;
}

function conversation(value: unknown, expectedUsername?: string): Conversation {
  const raw = object(value);
  if (
    typeof raw.username !== "string" ||
    !raw.username.trim() ||
    (expectedUsername !== undefined && raw.username !== expectedUsername) ||
    !Number.isSafeInteger(raw.unAcknowledgedMessageCount) ||
    (raw.unAcknowledgedMessageCount as number) < 0
  )
    throw remote();
  return {
    username: raw.username,
    isActive: typeof raw.isActive === "boolean" ? raw.isActive : null,
    unacknowledgedMessageCount: raw.unAcknowledgedMessageCount as number,
  };
}

function normalizeMessages(value: unknown, username: string): PrivateMessage[] {
  if (!Array.isArray(value)) throw remote();
  const messages = new Map<string, PrivateMessage>();
  for (const item of value) {
    const raw = object(item);
    if (
      raw.username !== username ||
      !Number.isSafeInteger(raw.id) ||
      (raw.id as number) < -2_147_483_648 ||
      (raw.id as number) > 2_147_483_647 ||
      typeof raw.timestamp !== "string" ||
      !Number.isFinite(Date.parse(raw.timestamp)) ||
      typeof raw.message !== "string" ||
      typeof raw.isAcknowledged !== "boolean" ||
      (raw.direction !== "In" && raw.direction !== "Out")
    )
      throw remote();
    // Preserve timestamp precision: Date conversion would lose .NET's sub-millisecond identity.
    const messageId = `msg_${createHash("sha256")
      .update(JSON.stringify([username, raw.id, raw.timestamp]))
      .digest("base64url")}`;
    messages.set(messageId, {
      messageId,
      serverId: raw.id as number,
      username,
      timestamp: raw.timestamp,
      direction: raw.direction === "In" ? "incoming" : "outgoing",
      text: raw.message,
      isAcknowledged: raw.isAcknowledged,
      wasReplayed: typeof raw.wasReplayed === "boolean" ? raw.wasReplayed : null,
    });
  }
  return [...messages.values()].sort(compareMessages);
}

function compareMessages(a: PrivateMessage, b: PrivateMessage): number {
  // System.Text.Json can omit trailing fractional zeros, while Date loses sub-millisecond precision.
  const fraction = (timestamp: string) => (timestamp.match(/\.(\d+)/)?.[1] ?? "").padEnd(9, "0");
  return (
    Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
    fraction(a.timestamp).localeCompare(fraction(b.timestamp)) ||
    a.username.localeCompare(b.username) ||
    a.messageId.localeCompare(b.messageId)
  );
}

async function getConversation(ctx: Context, username: string): Promise<Conversation> {
  try {
    return conversation(
      await request(ctx, "GET", `${pathFor(username)}?includeMessages=false`),
      username,
    );
  } catch (error) {
    if (error instanceof CliError && error.code === "REMOTE" && error.message.includes("HTTP 404"))
      throw new CliError("MISSING_CONVERSATION", "The conversation is not available in slskd.", 7);
    throw error;
  }
}

export async function messageConversations(ctx: Context, unacknowledged = false) {
  const raw = await request(
    ctx,
    "GET",
    `conversations?includeInactive=true&unAcknowledgedOnly=${unacknowledged}`,
  );
  if (!Array.isArray(raw)) throw remote();
  const conversations = raw
    .map((item) => conversation(item))
    .filter((item) => !unacknowledged || item.unacknowledgedMessageCount > 0)
    .sort((a, b) => a.username.localeCompare(b.username));
  return { conversations };
}

export async function messageList(ctx: Context, username: string, unacknowledged = false) {
  const summary = await getConversation(ctx, username);
  const messages = normalizeMessages(
    await request(ctx, "GET", `${pathFor(username)}/messages`),
    username,
  );
  return {
    conversation: summary,
    messages: messages.filter(
      (item) => !unacknowledged || (item.direction === "incoming" && !item.isAcknowledged),
    ),
    history: { ...HISTORY, returnedBeforeFilter: messages.length },
  };
}

async function mutate(ctx: Context, method: string, path: string, body?: unknown) {
  try {
    return await requestWithStatus(ctx, method, path, body, true);
  } catch (error) {
    // slskd can send a network message/ACK and then fail while persisting it.
    if (error instanceof CliError && error.code === "REMOTE" && /HTTP 5\d\d/.test(error.message))
      throw new CliError(
        "AMBIGUOUS_MUTATION",
        "slskd failed during the mutation; its outcome is unknown. Inspect slskd before retrying.",
        9,
      );
    throw error;
  }
}

export async function messageSend(ctx: Context, username: string, text: string, yes: unknown) {
  requireYes(yes);
  const path = pathFor(username);
  if (typeof text !== "string" || !text.trim()) throw input("Message text must not be blank.");
  const response = await mutate(ctx, "POST", path, text);
  if (response.status === 200)
    throw new CliError(
      "MESSAGE_REJECTED",
      "slskd skipped sending the message; the recipient may be blacklisted. No automatic retry was made.",
      7,
    );
  if (response.status !== 201)
    throw new CliError(
      "AMBIGUOUS_MUTATION",
      "slskd returned an unexpected send response; submission could not be confirmed. Do not retry blindly.",
      9,
    );
  return { username, submitted: true, delivered: null, read: null };
}

type AckOutcome = {
  messageId: string;
  outcome: "acknowledged" | "existing" | "failed" | "uncertain" | "not_attempted";
  error?: { code: string; message: string };
};

export async function messageAcknowledge(
  ctx: Context,
  username: string,
  ids: string[],
  all: boolean,
  yes: unknown,
) {
  requireYes(yes);
  messageUsername(username);
  if ((all && ids.length > 0) || (!all && ids.length === 0))
    throw input("Select one or more --id message references or use --all, not both.");
  const selectedIds = [...new Set(ids)];
  if (selectedIds.some((id) => !/^msg_[A-Za-z0-9_-]{43}$/.test(id)))
    throw input("Use messageId references returned by message list or message watch.");
  const before = await messageList(ctx, username);
  const selected = selectedIds.map((id) => {
    const message = before.messages.find((item) => item.messageId === id);
    if (!message || message.direction !== "incoming")
      throw input(
        "A selected incoming message is not available in this conversation's current history window.",
      );
    if (before.messages.filter((item) => item.serverId === message.serverId).length !== 1)
      throw input(
        "slskd cannot individually acknowledge this reused server ID. Use --all only if you intend to acknowledge the entire conversation.",
      );
    return message;
  });
  if (all) {
    try {
      await mutate(ctx, "PUT", pathFor(username));
    } catch (error) {
      // ACK-all can complete some network ACKs before a later failure.
      if (error instanceof CliError && error.code === "AMBIGUOUS_MUTATION")
        return {
          exitCode: 9,
          username,
          all: true,
          outcome: "uncertain",
          error: { code: error.code, message: error.message },
        };
      throw error;
    }
    try {
      const after = await getConversation(ctx, username);
      if (after.unacknowledgedMessageCount !== 0) throw remote();
      return { exitCode: 0, username, all: true, outcome: "acknowledged" };
    } catch {
      return {
        exitCode: 9,
        username,
        all: true,
        outcome: "uncertain",
        error: {
          code: "AMBIGUOUS_MUTATION",
          message:
            "Acknowledgement was submitted, but an empty pending count could not be verified; messages may have arrived or replayed concurrently.",
        },
      };
    }
  }
  const outcomes: AckOutcome[] = selected.map((message) => ({
    messageId: message.messageId,
    outcome: "not_attempted",
  }));
  let exitCode = 0;
  for (const [index, message] of selected.entries()) {
    if (message.isAcknowledged) {
      outcomes[index]!.outcome = "existing";
      continue;
    }
    let submitted = false;
    try {
      await mutate(ctx, "PUT", `${pathFor(username)}/${message.serverId}`);
      submitted = true;
      const after = await messageList(ctx, username);
      const matches = after.messages.filter((item) => item.serverId === message.serverId);
      if (
        matches.length !== 1 ||
        matches[0]!.messageId !== message.messageId ||
        !matches[0]!.isAcknowledged
      )
        throw new CliError(
          "AMBIGUOUS_MUTATION",
          "Acknowledgement was submitted but the selected message's state could not be verified; inspect current history before retrying.",
          9,
        );
      outcomes[index]!.outcome = "acknowledged";
    } catch (error) {
      const typed = error instanceof CliError ? error : remote();
      const uncertain = submitted || typed.code === "AMBIGUOUS_MUTATION";
      const failure = uncertain
        ? new CliError(
            "AMBIGUOUS_MUTATION",
            "The selected message's acknowledgement could not be confirmed; inspect slskd before retrying.",
            9,
          )
        : typed;
      outcomes[index] = {
        messageId: message.messageId,
        outcome: uncertain ? "uncertain" : "failed",
        error: { code: failure.code, message: failure.message },
      };
      exitCode = failure.exitCode;
      break; // Preserve previous outcomes; do not keep mutating after a failure.
    }
  }
  return { exitCode, username, all: false, messages: outcomes };
}

export type MessageWatchOptions = {
  username?: string;
  newOnly?: boolean;
  pollIntervalMs?: number;
  timeoutSeconds?: number;
};

export function resolveMessageWatchOptions(options: MessageWatchOptions = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000)
    throw input("pollIntervalMs must be an integer from 100 to 60000.");
  if (
    options.timeoutSeconds !== undefined &&
    (!Number.isSafeInteger(options.timeoutSeconds) ||
      options.timeoutSeconds < 1 ||
      options.timeoutSeconds > 2_147_483)
  )
    throw input("timeout must be an integer from 1 to 2147483 seconds.");
  if (options.username !== undefined) messageUsername(options.username);
  return { ...options, pollIntervalMs };
}

/** Poll all available history, not just pending messages: another client may ACK between polls. */
export async function* messageWatch(ctx: Context, options: MessageWatchOptions = {}) {
  const settings = resolveMessageWatchOptions(options);
  const controller = new AbortController();
  const deadline = new Error("Message observation duration reached.");
  const abort = () => controller.abort(ctx.signal?.reason);
  ctx.signal?.addEventListener("abort", abort, { once: true });
  if (ctx.signal?.aborted) abort();
  const timer =
    settings.timeoutSeconds === undefined
      ? undefined
      : setTimeout(() => controller.abort(deadline), settings.timeoutSeconds * 1000);
  const watchCtx = { ...ctx, signal: controller.signal };
  const seen = new Set<string>();
  let initial = true;
  let messageCount = 0;
  try {
    while (true) {
      controller.signal.throwIfAborted();
      const usernames =
        settings.username === undefined
          ? (await messageConversations(watchCtx)).conversations.map((item) => item.username)
          : [settings.username];
      const snapshot: PrivateMessage[] = [];
      for (const username of usernames) {
        try {
          snapshot.push(...(await messageList(watchCtx, username)).messages);
        } catch (error) {
          // A filtered watcher can wait for the first message from a new peer.
          if (!(error instanceof CliError && error.code === "MISSING_CONVERSATION")) throw error;
        }
      }
      snapshot.sort(compareMessages);
      controller.signal.throwIfAborted();
      if (initial)
        yield { event: "started", username: settings.username ?? null, history: HISTORY };
      for (const message of snapshot) {
        controller.signal.throwIfAborted();
        if (seen.has(message.messageId)) continue;
        seen.add(message.messageId);
        if (
          message.direction !== "incoming" ||
          (initial && (settings.newOnly || message.isAcknowledged))
        )
          continue;
        messageCount += 1;
        yield { event: "message", message };
      }
      initial = false;
      await delay(settings.pollIntervalMs, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (!controller.signal.aborted || controller.signal.reason !== deadline) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    }
    yield { event: "ended", reason: "deadline", messageCount };
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", abort);
  }
}
