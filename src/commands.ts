import * as Context from "effect/Context";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as CliConfig from "effect/cli/CliConfig";
import * as CliOutput from "effect/cli/CliOutput";
import * as Command from "effect/cli/Command";
import * as CommandSpec from "effect/cli/CommandSpec";
import * as Flag from "effect/cli/Flag";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import * as Param from "effect/cli/Param";
import * as Primitive from "effect/cli/Primitive";
import { CliError, CoreFailure, failure, requireYes, type RequestFailure } from "./core.js";

export type Flags = Record<string, string | boolean | string[]>;
const fail = (message: string) => failure("INVALID_INPUT", message, 2);
type Category =
  | "connection"
  | "message"
  | "watch"
  | "search"
  | "acknowledgement"
  | "folder"
  | "help";
const FlagCategory = Context.Service<never, Category>("slskd-cli/FlagCategory");
type Policy = { allowed: ReadonlyArray<string>; mutation: boolean };
const CommandPolicy = Context.Service<never, Policy>("slskd-cli/CommandPolicy");
// NUL is impossible in process argv. It protects literal single-dash operands from short-option parsing.
const unescape = (value: string) => (value.startsWith("\0") ? value.slice(1) : value);
const boolean = (name: string, category: Category) =>
  Param.makeSingle({
    kind: "flag",
    name,
    primitiveType: {
      ...Primitive.Boolean,
      parse: (value: string) =>
        value === "\0" ? Effect.succeed(true) : Effect.fail(`--${name} does not take a value.`),
    },
    optionalValue: "\0",
    negation: false,
  }).pipe(Flag.optional, Flag.annotate(FlagCategory, category));
const string = (name: string, category: Category) =>
  Flag.String(name).pipe(Flag.map(unescape), Flag.optional, Flag.annotate(FlagCategory, category));
const flags = {
  help: boolean("help", "help"),
  yes: boolean("yes", "acknowledgement"),
  all: boolean("all", "folder"),
  watch: boolean("watch", "watch"),
  stdin: boolean("stdin", "message"),
  unacknowledged: boolean("unacknowledged", "message"),
  "new-only": boolean("new-only", "message"),
  "base-url": string("base-url", "connection"),
  "api-key": string("api-key", "connection"),
  "timeout-ms": string("timeout-ms", "connection"),
  query: string("query", "search"),
  "lifetime-seconds": string("lifetime-seconds", "search"),
  text: string("text", "message"),
  username: string("username", "message"),
  timeout: string("timeout", "message"),
  "poll-interval-ms": string("poll-interval-ms", "watch"),
  "watch-timeout-seconds": string("watch-timeout-seconds", "watch"),
  id: Flag.String("id").pipe(
    Flag.map(unescape),
    Flag.atLeast(0),
    Flag.annotate(FlagCategory, "message"),
  ),
};

/** Preserve diagnostic order while sharing each command's policy with generated help. */
function validateFlags(
  words: string[],
  values: Flags,
  spec: CommandSpec.Spec,
  known: boolean,
  policy?: Policy,
): void {
  const categoryPresent = (category: Category) =>
    spec.flags.some(
      (flag) => flag.name in values && Context.get(flag.annotations, FlagCategory) === category,
    );
  if (words[0] === "message") {
    if (!known) throw fail("Unknown message command.");
    const allowed = new Set(policy!.allowed);
    if (
      spec.flags.some(
        (flag) =>
          flag.name in values &&
          Context.get(flag.annotations, FlagCategory) !== "connection" &&
          !allowed.has(flag.name),
      )
    )
      throw fail("A flag is not valid for this message command.");
    return;
  }
  if (categoryPresent("message")) throw fail("Message flags require a message command.");
  if (categoryPresent("watch") && (!policy?.allowed.includes("watch") || values.watch !== true))
    throw fail("Watch options require search candidates --watch.");
  if (words.length === 1 && spec.name === words[0] && spec.subcommands.length > 0) return;
  if (
    values.all !== undefined &&
    (!policy?.allowed.includes("all") || !words[2]?.startsWith("folder_"))
  )
    throw fail("--all requires transfer enqueue with a folderRef.");
  if (policy?.mutation) {
    try {
      requireYes(values.yes);
    } catch (error) {
      if (error instanceof CliError) throw failure(error.code, error.message, error.exitCode);
      throw error;
    }
  } else if (values.yes) throw fail("--yes is only valid for state-changing commands.");
  if (categoryPresent("search") && !policy?.allowed.includes("query"))
    throw fail("Search flags are only valid for search create.");
  if (!known || (words[0] === "check" && words.length > 1)) throw fail("Unknown command.");
}

/** Keep application failures out of Effect's rendered parser diagnostics. */
function parserFailure(error: unknown): CoreFailure {
  if (error instanceof CoreFailure) return error;
  const value = error as {
    _tag?: string;
    errors?: unknown[];
    option?: string;
    expected?: string;
    value?: string;
  };
  if (value?._tag === "ShowHelp") return parserFailure(value.errors?.[0]);
  if (value?._tag === "InvalidValue" && value.expected === "string" && value.value === "")
    return fail(`--${value.option} requires a value.`);
  if (value?._tag === "MissingOption") return fail(`--${value.option} requires a value.`);
  if (value?._tag === "InvalidValue" && value.expected?.endsWith(" does not take a value."))
    return fail(value.expected);
  if (value?._tag === "UnknownSubcommand") return fail("Unknown command.");
  return fail("Unknown or repeated command flag.");
}

/** Bridge lexical differences only; all names, repeat bounds, and value kinds come from the Effect tree. */
function lexicalInput(argv: string[], spec: CommandSpec.Spec): string[] {
  const definitions = new Map(spec.flags.map((flag) => [flag.name, flag]));
  const seen = new Set<string>();
  const output: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      output.push(token.startsWith("-") ? `\0${token}` : token);
      continue;
    }
    const separator = token.indexOf("=");
    const name = token.slice(2, separator < 0 ? undefined : separator);
    const definition = definitions.get(name);
    if (!definition || (seen.has(name) && !definition.variadic))
      throw fail("Unknown or repeated command flag.");
    seen.add(name);
    if (definition.type._tag === "Boolean") {
      if (separator >= 0) throw fail(`--${name} does not take a value.`);
      output.push(token);
    } else if (separator >= 0) output.push(token);
    else {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw fail(`--${name} requires a value.`);
      // Inline spelling prevents Effect from reading a single-dash value as a short option.
      output.push(`--${name}=${value}`);
    }
  }
  return output;
}

type Dispatch = (
  words: string[],
  flags: Flags,
  validateOperands: Effect.Effect<void, CoreFailure>,
) => Effect.Effect<void, RequestFailure>;

/** One command tree owns parsing, validation, and offline generated help. */
export function runCommands(argv: string[], dispatch: Dispatch) {
  let help: (path: string[]) => Effect.Effect<void, unknown, Command.Environment>;
  const formatter = CliOutput.defaultFormatter({ colors: false });
  const presenter: CliOutput.Presenter = {
    present: (event) =>
      Effect.sync(() => {
        if (event._tag === "Help" && event.reason === "Requested") {
          const spec = Option.getOrThrow(
            CommandSpec.resolve(tree, event.commandPath, { builtIns: [] }),
          );
          const policy = Option.getOrUndefined(Context.getOption(spec.annotations, CommandPolicy));
          const visible = new Set(
            spec.flags
              .filter((flag) => {
                const category = Context.get(flag.annotations, FlagCategory);
                return (
                  !policy ||
                  category === "connection" ||
                  category === "help" ||
                  policy.allowed.includes(flag.name) ||
                  (policy.mutation && flag.name === "yes")
                );
              })
              .map((flag) => flag.name),
          );
          const helpDoc = {
            ...event.helpDoc,
            inheritedFlags: (event.helpDoc.inheritedFlags ?? []).filter((flag) =>
              visible.has(flag.name),
            ),
          };
          process.stdout.write(
            formatter.formatHelpDoc(helpDoc).replaceAll("[=boolean]", "") + "\n",
          );
        }
      }),
  };
  const renderHelp = GlobalFlag.Action({
    flag: Flag.Boolean("__render-help").pipe(Flag.withHidden),
    run: GlobalFlag.Help.run,
  });
  const root = Command.make("slskd", {
    operands: Argument.String("operands").pipe(Argument.map(unescape), Argument.variadic()),
  }).pipe(
    Command.withSharedFlags(flags),
    Command.withHandler((parsed) => fallback([], [...parsed.operands], normalizeFlags(parsed))),
  );
  function normalizeFlags(parsed: Record<string, unknown>): Flags {
    const values: Flags = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in flags)) continue;
      if (Array.isArray(value)) {
        if (value.length) values[key] = value as string[];
      } else if (Option.isSome(value as Option.Option<string | boolean>))
        values[key] = (value as Option.Some<string | boolean>).value;
    }
    return values;
  }
  const getFlags = Effect.map(root, normalizeFlags);
  const operands = (name: string) =>
    Argument.String(name).pipe(Argument.map(unescape), Argument.variadic());
  function operation(
    path: string[],
    names: string,
    count: number | ((values: readonly string[]) => boolean),
    description: string,
    allowed: ReadonlyArray<keyof typeof flags> = [],
    mutation = false,
  ) {
    const policy: Policy = { allowed, mutation };
    return Command.make(
      path.at(-1)!,
      { operands: operands(names) },
      ({
        operands,
      }): Effect.Effect<void, unknown, Command.Environment | Command.CommandContext<"slskd">> =>
        Effect.gen(function* () {
          const flags = yield* getFlags;
          if (flags.help === true) {
            if (operands.length) return yield* Effect.fail(fail("Unknown help topic."));
            return yield* help(path);
          }
          const spec = Option.getOrThrow(
            CommandSpec.resolve(tree, ["slskd", ...path], { builtIns: [] }),
          );
          yield* Effect.try({
            try: () => validateFlags([...path, ...operands], flags, spec, true, policy),
            catch: (error) => error as CoreFailure,
          });
          const schema = Schema.Array(Schema.String).pipe(
            Schema.check(
              Schema.makeFilter(
                (values) =>
                  (path[0] === "message" || values.every((value) => value.length > 0)) &&
                  (typeof count === "number" ? values.length === count : count(values)),
              ),
            ),
          );
          const validateOperands = Schema.decodeUnknownEffect(schema)(operands).pipe(
            Effect.asVoid,
            Effect.mapError(() => fail("Invalid command arguments.")),
          );
          return yield* dispatch([...path, ...operands], flags, validateOperands);
        }),
    ).pipe(Command.withDescription(description), Command.annotate(CommandPolicy, policy));
  }
  function fallback(
    path: string[],
    values: string[],
    parsed: Flags,
  ): Effect.Effect<void, unknown, Command.Environment> {
    return Effect.gen(function* () {
      if (parsed.help === true) {
        if (values.length) return yield* Effect.fail(fail("Unknown help topic."));
        return yield* help(path);
      }
      if (path.length === 0 && values.length === 0 && Object.keys(parsed).length === 0)
        return yield* help([]);
      if (path[0] === "message" && values.length === 0 && Object.keys(parsed).length === 0)
        return yield* help(path);
      const spec = Option.getOrThrow(
        CommandSpec.resolve(tree, ["slskd", ...path], { builtIns: [] }),
      );
      yield* Effect.try({
        try: () => validateFlags([...path, ...values], parsed, spec, false),
        catch: (error) => error as CoreFailure,
      });
      if (path.length === 1 && values.length === 0) return yield* help(path);
      return yield* dispatch([...path, ...values], parsed, Effect.void);
    });
  }
  const group = <const Commands extends ReadonlyArray<Command.Command.Any>>(
    name: string,
    commands: Commands,
  ) =>
    Command.make(name, { operands: operands("operands") }, ({ operands }) =>
      Effect.flatMap(getFlags, (flags) => fallback([name], [...operands], flags)),
    ).pipe(Command.withSubcommands(commands));
  const helpCommand = Command.make("help", { topic: operands("topic") }, ({ topic }) =>
    Effect.gen(function* () {
      if (
        topic[0] === "help" ||
        Option.isNone(CommandSpec.resolve(tree, ["slskd", ...topic], { builtIns: [] }))
      )
        return yield* Effect.fail(fail("Unknown help topic."));
      yield* help([...topic]);
    }),
  );
  const tree = root.pipe(
    Command.withSubcommands([
      operation(["check"], "operands", 0, "Check connectivity and slskd compatibility."),
      group("search", [
        operation(["search", "list"], "operands", 0, "List Searches stored in slskd."),
        operation(
          ["search", "create"],
          "operands",
          0,
          "Create a literal Search with --query and optional --lifetime-seconds.",
          ["query", "lifetime-seconds"],
        ),
        operation(
          ["search", "candidates"],
          "searchId",
          1,
          "Inspect Candidates. Use --watch to observe started, progress, candidate, and ended events.",
          ["watch", "poll-interval-ms", "watch-timeout-seconds"],
        ),
        operation(["search", "delete"], "searchId", 1, "Delete a Search with --yes.", [], true),
        operation(
          ["search", "folder"],
          "searchId candidateId | folderRef",
          (values) => values.length === 1 || values.length === 2,
          "Discover with <searchId> <candidateId>, or refresh with <folderRef>. Requires --yes.",
          [],
          true,
        ),
      ]),
      group("transfer", [
        operation(
          ["transfer", "enqueue"],
          "searchId candidateId | folderRef fileId ...",
          (values) => values[0]?.startsWith("folder_") === true || values.length === 2,
          "Enqueue <searchId> <candidateId>, or <folderRef> <fileId ...>, or <folderRef> --all. Requires --yes.",
          ["all"],
          true,
        ),
        operation(["transfer", "show"], "username transferId", 2, "Show a download Transfer."),
        operation(
          ["transfer", "cancel"],
          "username transferId",
          2,
          "Cancel a download Transfer with --yes.",
          [],
          true,
        ),
        operation(
          ["transfer", "clear"],
          "operands",
          0,
          "Clear completed download records with --yes.",
          [],
          true,
        ),
        operation(
          ["transfer", "delete"],
          "username transferId",
          2,
          "Delete a download Transfer record with --yes.",
          [],
          true,
        ),
      ]),
      group("message", [
        operation(
          ["message", "conversations"],
          "operands",
          0,
          "List Conversations. Use --unacknowledged for pending messages.",
          ["unacknowledged"],
        ),
        operation(
          ["message", "list"],
          "username",
          1,
          "Inspect available Private messages without acknowledgement.",
          ["unacknowledged"],
        ),
        operation(
          ["message", "send"],
          "username",
          1,
          "Send one Private message with --text or --stdin and --yes.",
          ["text", "stdin", "yes"],
          true,
        ),
        operation(
          ["message", "acknowledge"],
          "username",
          1,
          "Acknowledge incoming Private messages with repeated --id or --all and --yes.",
          ["id", "all", "yes"],
          true,
        ),
        operation(
          ["message", "watch"],
          "operands",
          0,
          "Observe incoming messages with --username, --new-only, --poll-interval-ms, and --timeout.",
          ["username", "new-only", "poll-interval-ms", "timeout"],
        ),
      ]),
      helpCommand,
    ]),
  );
  help = (path: string[]) =>
    Command.runWith(tree, { version: "0.1.0-beta.1", renderErrors: false })([
      ...path,
      "--__render-help",
    ]).pipe(Effect.provideService(CliConfig.CliConfig, CliConfig.make({ builtIns: [renderHelp] })));
  return Effect.gen(function* () {
    const spec = Option.getOrThrow(CommandSpec.resolve(tree, ["slskd"], { builtIns: [] }));
    const input = yield* Effect.try({
      try: () => lexicalInput(argv, spec),
      catch: (error) => error as CoreFailure,
    });
    yield* Command.runWith(tree, { version: "0.1.0-beta.1", renderErrors: false })(input).pipe(
      Effect.mapError(parserFailure),
    );
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(CliOutput.Presenter, presenter),
    Effect.provideService(CliConfig.CliConfig, CliConfig.make({ builtIns: [] })),
  );
}
