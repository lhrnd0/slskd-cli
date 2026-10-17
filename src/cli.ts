#!/usr/bin/env node
import { CliError, compatible, resolveContext, requireYes } from './core.js';
import { searchCreate, searchCandidates } from './search.js';
import { transferEnqueue } from './enqueue.js';
import { transferCancel, transferClear, transferDelete, transferInspect } from './transfer.js';

type Flags = Record<string, string | boolean>;
const VALUE_FLAGS = new Set(['base-url', 'api-key', 'timeout-ms', 'query', 'lifetime-seconds']);
const ALL_FLAGS = new Set([...VALUE_FLAGS, 'yes']);

function parse(argv: string[]): { words: string[]; flags: Flags } {
  const words: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    const name = arg.slice(2);
    if (!ALL_FLAGS.has(name) || name in flags) throw new CliError('INVALID_INPUT', 'Unknown or repeated command flag.', 2);
    if (name === 'yes') { flags[name] = true; continue; }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new CliError('INVALID_INPUT', `--${name} requires a value.`, 2);
    flags[name] = value;
  }
  return { words, flags };
}

function requireWords(words: string[], count: number): void {
  if (words.length !== count || words.some((word) => !word)) {
    throw new CliError('INVALID_INPUT', 'Invalid command arguments.', 2);
  }
}

async function run(argv: string[]): Promise<unknown> {
  const { words, flags } = parse(argv);
  const command = words.slice(0, 2).join(' ');
  const isMutation = command === 'transfer enqueue' || command === 'transfer cancel'
    || command === 'transfer clear' || command === 'transfer delete';
  if (isMutation) requireYes(flags.yes);
  else if (flags.yes) throw new CliError('INVALID_INPUT', '--yes is only valid for state-changing commands.', 2);
  const searchFlags = new Set(['query', 'lifetime-seconds']);
  if (command !== 'search create' && Object.keys(flags).some((key) => searchFlags.has(key))) {
    throw new CliError('INVALID_INPUT', 'Search flags are only valid for search create.', 2);
  }
  if (!['check', 'search create', 'search candidates', 'transfer enqueue', 'transfer show',
    'transfer cancel', 'transfer clear', 'transfer delete'].includes(command)
    && !(words.length === 1 && words[0] === 'check')) {
    throw new CliError('INVALID_INPUT', 'Unknown command.', 2);
  }
  const ctx = resolveContext(flags);
  const verified = await compatible(ctx);
  if (words[0] === 'check') { requireWords(words, 1); return verified; }
  if (command === 'search create') {
    requireWords(words, 2);
    const lifetime = flags['lifetime-seconds'] === undefined ? 60 : Number(flags['lifetime-seconds']);
    return searchCreate(ctx, flags.query as string, lifetime);
  }
  if (command === 'search candidates') {
    requireWords(words, 3);
    return { searchId: words[2], candidates: await searchCandidates(ctx, words[2]!) };
  }
  if (command === 'transfer enqueue') {
    requireWords(words, 4);
    return transferEnqueue(ctx, words[2]!, words[3]!, flags.yes);
  }
  if (command === 'transfer clear') { requireWords(words, 2); return transferClear(ctx, flags.yes); }
  requireWords(words, 4);
  if (command === 'transfer show') return transferInspect(ctx, words[2]!, words[3]!);
  if (command === 'transfer cancel') return transferCancel(ctx, words[2]!, words[3]!, flags.yes);
  return transferDelete(ctx, words[2]!, words[3]!, flags.yes);
}

try {
  const value = await run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify({ ok: true, result: value })}\n`);
} catch (error) {
  const failure = error instanceof CliError ? error : new CliError('REMOTE', 'Unexpected CLI failure.', 7);
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } })}\n`);
  process.exitCode = failure.exitCode;
}
