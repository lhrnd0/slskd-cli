#!/usr/bin/env node
import { CliError, check, compatible, resolveContext, requireYes } from "./core.js";
import {
  searchCreate,
  searchCandidates,
  searchDelete,
  searchList,
  resolveSearchWatchOptions,
} from "./search.js";
import { folderDiscover, folderShow } from "./folder.js";
import { folderEnqueue } from "./folder-enqueue.js";
import { transferEnqueue } from "./enqueue.js";
import { transferCancel, transferClear, transferDelete, transferInspect } from "./transfer.js";
import { runSearchWatch } from "./watch-cli.js";
import { MESSAGE_FLAGS, MESSAGE_HELP, runMessageCommand } from "./message-cli.js";

type Flags = Record<string, string | boolean | string[]>;
const VALUE_FLAGS = new Set([
  "base-url",
  "api-key",
  "timeout-ms",
  "query",
  "lifetime-seconds",
  "poll-interval-ms",
  "watch-timeout-seconds",
  "text",
  "id",
  "username",
  "timeout",
]);
const BOOLEAN_FLAGS = new Set([
  "help",
  "yes",
  "watch",
  "all",
  "stdin",
  "unacknowledged",
  "new-only",
]);
const ALL_FLAGS = new Set([...VALUE_FLAGS, ...BOOLEAN_FLAGS]);

class StreamedResult {}

class HelpResult {
  constructor(readonly text: string) {}
}

const HELP = new Map<string, string>([
  [
    "",
    `Usage: slskd <command> [options]

Commands:
  check                         Check connectivity and slskd compatibility
  search list                   List existing searches
  search create                 Create a search
  search candidates             List candidates for a search
  search delete                 Delete a search
  search folder                 Discover or refresh a complete release folder
  transfer enqueue              Enqueue a candidate or selected folder files
  transfer show                 Show a download transfer
  transfer cancel               Cancel a download transfer
  transfer clear                Clear completed downloads
  transfer delete               Delete a transfer record
  message conversations         List private conversations
  message list                  Inspect private messages
  message send                  Send one private message
  message acknowledge           Acknowledge incoming messages
  message watch                 Watch incoming private messages

Run "slskd <command> --help" for command-specific help.`,
  ],
  [
    "check",
    `Usage: slskd check [connection options]\n\nCheck connectivity and slskd compatibility.`,
  ],
  [
    "search",
    `Usage: slskd search <command>

Commands:
  list                           List existing searches
  create                         Create a search
  candidates <searchId>          List candidates for a search
  folder <searchId> <candidateId> --yes
                                Discover a candidate’s release folder
  folder <folderRef> --yes       Refresh a discovered folder
  delete <searchId> --yes        Delete a search`,
  ],
  [
    "search list",
    `Usage: slskd search list [connection options]\n\nList active and completed searches stored in slskd.`,
  ],
  [
    "search create",
    `Usage: slskd search create --query <text> [--lifetime-seconds <seconds>] [connection options]

Create a literal slskd search. Lifetime must be between 5 and 300 seconds and defaults to 60.`,
  ],
  [
    "search candidates",
    `Usage: slskd search candidates <searchId> [--watch] [connection options]

List normalized candidates using the slskd UUID from search create or search list.
With --watch, stream started, progress, candidate, and ended events as newline-delimited JSON.
Watch options:
  --poll-interval-ms <ms>          Integer 100..60000; default 1000
  --watch-timeout-seconds <sec>    Integer 1..3600; default 300
Progress reports state and responseCount, fileCount, lockedFileCount on every poll.
Counts may rise before Candidates are available; slskd 0.26.1 buffers results until completion.
Wait for ended with reason completed before treating the Candidates as final.
A completed Search is drained before ended/completed. The watch deadline emits
ended/deadline with exit 0, which does not imply collection finished.
Resume watching the same Search after a deadline; unchanged counts do not mean completion.
Candidate IDs are emitted once per invocation; a fresh watch replays existing Candidates.
Request timeouts retain typed errors. SIGINT/SIGTERM stop observation with exit 130/143.
Watching is read-only and leaves the Search available in slskd.`,
  ],
  [
    "search delete",
    `Usage: slskd search delete <searchId> --yes [connection options]

Delete a search and its stored responses from slskd.`,
  ],
  [
    "transfer",
    `Usage: slskd transfer <command>

Commands:
  enqueue <searchId> <candidateId> --yes
  enqueue <folderRef> <fileId ...> --yes
  enqueue <folderRef> --all --yes
  show <username> <transferId>
  cancel <username> <transferId> --yes
  clear --yes
  delete <username> <transferId> --yes`,
  ],
  [
    "search folder",
    `Usage: slskd search folder <searchId> <candidateId> --yes [connection options]
       slskd search folder <folderRef> --yes [connection options]

Request the selected peer's complete immediate folder, including files absent from the Search.
Use a previously returned folderRef to refresh the listing.
Returns folderRef and fileIds for inspection and enqueue. Never starts Transfers.
The peer directory request requires --yes and uses the configured request timeout.`,
  ],
  [
    "transfer enqueue",
    `Usage: slskd transfer enqueue <searchId> <candidateId> --yes [connection options]
       slskd transfer enqueue <folderRef> <fileId ...> --yes [connection options]
       slskd transfer enqueue <folderRef> --all --yes [connection options]

Enqueue a selected candidate or files from a folder returned by search folder.
A safe retry returns existing matching Transfers. Folder selections are revalidated.
--all includes non-audio extras, excludes nested directories, and reports skipped files.
Use explicit fileIds or --all, not both. Partial failures retain successful outcomes
with a nonzero exit status. Query slskd before retrying an uncertain mutation.`,
  ],
  [
    "transfer show",
    `Usage: slskd transfer show <username> <transferId> [connection options]

Show normalized state and progress for a download transfer.`,
  ],
  [
    "transfer cancel",
    `Usage: slskd transfer cancel <username> <transferId> --yes [connection options]

Cancel a download transfer. Completed or already cancelled transfers remain unchanged.`,
  ],
  [
    "transfer clear",
    `Usage: slskd transfer clear --yes [connection options]

Clear all completed download records in slskd.`,
  ],
  [
    "transfer delete",
    `Usage: slskd transfer delete <username> <transferId> --yes [connection options]

Delete one transfer record. An active transfer may be cancelled first.`,
  ],
  ...MESSAGE_HELP,
]);

function helpFor(words: string[], flags: Flags): HelpResult | undefined {
  const helpCommand = words[0] === "help";
  if (!helpCommand && flags.help !== true) return undefined;
  const topic = (helpCommand ? words.slice(1) : words).join(" ");
  const text = HELP.get(topic);
  if (text === undefined) throw new CliError("INVALID_INPUT", "Unknown help topic.", 2);
  return new HelpResult(`${text}\n`);
}

function parse(argv: string[]): { words: string[]; flags: Flags } {
  const words: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const separator = arg.indexOf("=");
    const name = arg.slice(2, separator < 0 ? undefined : separator);
    if (!ALL_FLAGS.has(name) || (name in flags && name !== "id"))
      throw new CliError("INVALID_INPUT", "Unknown or repeated command flag.", 2);
    if (BOOLEAN_FLAGS.has(name)) {
      if (separator >= 0)
        throw new CliError("INVALID_INPUT", `--${name} does not take a value.`, 2);
      flags[name] = true;
      continue;
    }
    const value = separator >= 0 ? arg.slice(separator + 1) : argv[++i];
    if (value === undefined || (separator < 0 && value.startsWith("--")))
      throw new CliError("INVALID_INPUT", `--${name} requires a value.`, 2);
    flags[name] = name === "id" ? [...(Array.isArray(flags.id) ? flags.id : []), value] : value;
  }
  return { words, flags };
}

function requireWords(words: string[], count: number): void {
  if (words.length !== count || words.some((word) => !word)) {
    throw new CliError("INVALID_INPUT", "Invalid command arguments.", 2);
  }
}

async function run(argv: string[]): Promise<unknown> {
  const { words, flags } = parse(argv);
  if (words.length === 0 && Object.keys(flags).length === 0)
    return new HelpResult(`${HELP.get("")}\n`);
  const help = helpFor(words, flags);
  if (help) return help;
  const command = words.slice(0, 2).join(" ");
  if (words[0] === "message") {
    if (words.length === 1 && Object.keys(flags).length === 0)
      return new HelpResult(`${HELP.get("message")}\n`);
    const value = await runMessageCommand(words, flags);
    if (value === undefined) return new StreamedResult();
    if (value.exitCode === 0) return value.result;
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        result: value.result,
        error: {
          code:
            value.exitCode === 9
              ? "AMBIGUOUS_MUTATION"
              : value.exitCode === 4
                ? "AUTHENTICATION"
                : "PARTIAL_ACKNOWLEDGEMENT",
          message:
            "Some acknowledgements could not be confirmed. Inspect per-message outcomes before retrying.",
        },
      })}\n`,
    );
    process.exitCode = value.exitCode;
    return new StreamedResult();
  }
  if (MESSAGE_FLAGS.some((flag) => flag in flags))
    throw new CliError("INVALID_INPUT", "Message flags require a message command.", 2);
  const watchOptions = ["poll-interval-ms", "watch-timeout-seconds"];
  if (
    (flags.watch !== undefined || watchOptions.some((key) => key in flags)) &&
    (command !== "search candidates" || flags.watch !== true)
  ) {
    throw new CliError("INVALID_INPUT", "Watch options require search candidates --watch.", 2);
  }
  if (
    (words.length === 1 && words[0] === "search") ||
    (words.length === 1 && words[0] === "transfer")
  ) {
    return new HelpResult(`${HELP.get(words[0])}\n`);
  }
  if (
    flags.all !== undefined &&
    (command !== "transfer enqueue" || !words[2]?.startsWith("folder_"))
  )
    throw new CliError("INVALID_INPUT", "--all requires transfer enqueue with a folderRef.", 2);
  const isMutation =
    command === "search folder" ||
    command === "search delete" ||
    command === "transfer enqueue" ||
    command === "transfer cancel" ||
    command === "transfer clear" ||
    command === "transfer delete";
  if (isMutation) requireYes(flags.yes);
  else if (flags.yes)
    throw new CliError("INVALID_INPUT", "--yes is only valid for state-changing commands.", 2);
  const searchFlags = new Set(["query", "lifetime-seconds"]);
  if (command !== "search create" && Object.keys(flags).some((key) => searchFlags.has(key))) {
    throw new CliError("INVALID_INPUT", "Search flags are only valid for search create.", 2);
  }
  if (
    ![
      "check",
      "search list",
      "search create",
      "search candidates",
      "search delete",
      "search folder",
      "transfer enqueue",
      "transfer show",
      "transfer cancel",
      "transfer clear",
      "transfer delete",
    ].includes(command) &&
    !(words.length === 1 && words[0] === "check")
  ) {
    throw new CliError("INVALID_INPUT", "Unknown command.", 2);
  }
  if (words[0] === "check") return check(flags);
  const ctx = resolveContext(flags);
  if (command === "search candidates" && flags.watch === true) {
    requireWords(words, 3);
    const watchOptions = resolveSearchWatchOptions({
      ...(flags["poll-interval-ms"] === undefined
        ? {}
        : { pollIntervalMs: Number(flags["poll-interval-ms"]) }),
      ...(flags["watch-timeout-seconds"] === undefined
        ? {}
        : { watchTimeoutSeconds: Number(flags["watch-timeout-seconds"]) }),
    });
    await runSearchWatch(ctx, words[2]!, watchOptions);
    return new StreamedResult();
  }
  await compatible(ctx);
  if (command === "search list") {
    requireWords(words, 2);
    return { searches: await searchList(ctx) };
  }
  if (command === "search create") {
    requireWords(words, 2);
    const lifetime =
      flags["lifetime-seconds"] === undefined ? 60 : Number(flags["lifetime-seconds"]);
    return searchCreate(ctx, flags.query as string, lifetime);
  }
  if (command === "search candidates") {
    requireWords(words, 3);
    return { searchId: words[2], candidates: await searchCandidates(ctx, words[2]!) };
  }
  if (command === "search delete") {
    requireWords(words, 3);
    return searchDelete(ctx, words[2]!);
  }
  if (command === "search folder") {
    if (words.length === 3) return folderShow(ctx, words[2]!, flags.yes);
    requireWords(words, 4);
    return folderDiscover(ctx, words[2]!, words[3]!, flags.yes);
  }
  if (command === "transfer enqueue" && words[2]?.startsWith("folder_")) {
    if (words.some((word) => !word))
      throw new CliError("INVALID_INPUT", "Invalid command arguments.", 2);
    const { exitCode, ...result } = await folderEnqueue(
      ctx,
      words[2]!,
      words.slice(3),
      flags.all === true,
      flags.yes,
    );
    if (exitCode !== 0) {
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          result,
          error: {
            code:
              exitCode === 9
                ? "AMBIGUOUS_MUTATION"
                : exitCode === 4
                  ? "AUTHENTICATION"
                  : exitCode === 2
                    ? "INVALID_INPUT"
                    : "PARTIAL_ENQUEUE",
            message:
              exitCode === 2
                ? "The folder has no eligible files to enqueue; inspect skipped files for details."
                : "Some selected files could not be confirmed enqueued; inspect per-file outcomes before retrying.",
          },
        })}\n`,
      );
      process.exitCode = exitCode;
      return new StreamedResult();
    }
    return result;
  }
  if (command === "transfer enqueue") {
    requireWords(words, 4);
    return transferEnqueue(ctx, words[2]!, words[3]!, flags.yes);
  }
  if (command === "transfer clear") {
    requireWords(words, 2);
    return transferClear(ctx, flags.yes);
  }
  requireWords(words, 4);
  if (command === "transfer show") return transferInspect(ctx, words[2]!, words[3]!);
  if (command === "transfer cancel") return transferCancel(ctx, words[2]!, words[3]!, flags.yes);
  return transferDelete(ctx, words[2]!, words[3]!, flags.yes);
}

try {
  const value = await run(process.argv.slice(2));
  if (!(value instanceof StreamedResult)) {
    process.stdout.write(
      value instanceof HelpResult ? value.text : `${JSON.stringify({ ok: true, result: value })}\n`,
    );
  }
} catch (error) {
  const failure =
    error instanceof CliError ? error : new CliError("REMOTE", "Unexpected CLI failure.", 7);
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } })}\n`,
  );
  process.exitCode = failure.exitCode;
}
