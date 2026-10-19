#!/usr/bin/env node
import { CliError, compatible, resolveContext, requireYes } from "./core.js";
import { searchCreate, searchCandidates, searchDelete, searchList } from "./search.js";
import { transferEnqueue } from "./enqueue.js";
import { transferCancel, transferClear, transferDelete, transferInspect } from "./transfer.js";

type Flags = Record<string, string | boolean>;
const VALUE_FLAGS = new Set(["base-url", "api-key", "timeout-ms", "query", "lifetime-seconds"]);
const ALL_FLAGS = new Set([...VALUE_FLAGS, "help", "yes"]);

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
  transfer enqueue              Enqueue a candidate for download
  transfer show                 Show a download transfer
  transfer cancel               Cancel a download transfer
  transfer clear                Clear completed downloads
  transfer delete               Delete a transfer record

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
    `Usage: slskd search candidates <searchId> [connection options]

List normalized candidates using the slskd UUID from search create or search list.`,
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
  show <username> <transferId>
  cancel <username> <transferId> --yes
  clear --yes
  delete <username> <transferId> --yes`,
  ],
  [
    "transfer enqueue",
    `Usage: slskd transfer enqueue <searchId> <candidateId> --yes [connection options]

Enqueue a selected candidate. A safe retry returns the existing matching transfer.`,
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
    const name = arg.slice(2);
    if (!ALL_FLAGS.has(name) || name in flags)
      throw new CliError("INVALID_INPUT", "Unknown or repeated command flag.", 2);
    if (name === "help" || name === "yes") {
      flags[name] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--"))
      throw new CliError("INVALID_INPUT", `--${name} requires a value.`, 2);
    flags[name] = value;
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
  if (
    (words.length === 1 && words[0] === "search") ||
    (words.length === 1 && words[0] === "transfer")
  ) {
    return new HelpResult(`${HELP.get(words[0])}\n`);
  }
  const command = words.slice(0, 2).join(" ");
  const isMutation =
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
  const ctx = resolveContext(flags);
  const verified = await compatible(ctx);
  if (words[0] === "check") {
    requireWords(words, 1);
    return verified;
  }
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
  process.stdout.write(
    value instanceof HelpResult ? value.text : `${JSON.stringify({ ok: true, result: value })}\n`,
  );
} catch (error) {
  const failure =
    error instanceof CliError ? error : new CliError("REMOTE", "Unexpected CLI failure.", 7);
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } })}\n`,
  );
  process.exitCode = failure.exitCode;
}
