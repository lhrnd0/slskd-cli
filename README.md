# slskd-cli

`slskd-cli` is a non-interactive JSON command line interface for one trusted [slskd](https://github.com/slskd/slskd) instance. The npm package installs the `slskd` command. It supports slskd **0.26.1 or later** and Node.js **24 or later**. The CLI keeps no Workflow database and never moves or deletes downloaded files.

## Install and build

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
pnpm test
pnpm pack --dry-run
```

The project declares its pnpm version in `package.json`. Run `corepack enable` once if your Node.js installation includes Corepack but pnpm is not available.

Run `pnpm format` to apply the repository's oxfmt rules. `pnpm lint:fix` applies safe oxlint fixes.

Contributions use [Conventional Commits](CONTRIBUTING.md#commit-messages). The repository's Git hook validates commit messages locally.

## Run after building

After `pnpm build`, run the generated entry point directly from the project directory:

```sh
node dist/cli.js --help
node dist/cli.js check
node dist/cli.js search create --query 'artist album'
```

`dist` is a directory, so Node must be given the complete `dist/cli.js` path. To make the `slskd` command available globally from a local checkout, link the package:

```sh
pnpm link --global
slskd --help
```

The npm package exposes `slskd` from `dist/cli.js`. After publication, install it with `pnpm add --global slskd-cli`. During development, either use `node dist/cli.js` in place of `slskd` below or create the global link shown above.

## Help

Help is available offline at the root, command-group, and individual-command levels. Both forms are supported:

```sh
node dist/cli.js --help
node dist/cli.js search --help
node dist/cli.js transfer enqueue --help
node dist/cli.js help search create
```

Running the CLI, `search`, `folder`, or `transfer` without further arguments also displays the relevant help. Help is plain text and does not read the Connection profile or contact slskd. Operational commands continue to emit exactly one JSON object.

## Connection profile

Create `$XDG_CONFIG_HOME/slskd-cli/config.toml`, or `~/.config/slskd-cli/config.toml` when `XDG_CONFIG_HOME` is unset:

```toml
[connection]
baseUrl = "http://127.0.0.1:5030"
apiKey = "your-readwrite-api-key"
timeoutMs = 30000
```

Keep the profile readable only by your user account (for example, `chmod 600 ~/.config/slskd-cli/config.toml` on Unix-like systems).

Set `SLSKD_CLI_CONFIG` to use a different profile file. `SLSKD_BASE_URL`, `SLSKD_API_KEY`, and `SLSKD_TIMEOUT_MS` override the profile. `--base-url`, `--api-key`, and `--timeout-ms` override both. Every HTTP request has its own timeout; the default is 30,000 ms. Configure a slskd **ReadWrite** API key. slskd's public version endpoint authenticates the key but does not disclose its role, so `check` cannot prove the role independently. A rejected API request produces `AUTHENTICATION`.

`check` reports `apiKeyRole: "unverified"` to make that limit explicit. Verify the role in your slskd configuration before allowing the CLI to enqueue downloads.

```sh
slskd check
```

Operational commands emit one JSON object on stdout. They never prompt or print the API key. Success uses `{"ok":true,"result":...}`; failure uses `{"ok":false,"error":{"code":"...","message":"..."}}`. stderr is reserved for process level failures.

## List searches

```sh
node dist/cli.js search list
```

`search list` returns `{searches:[...]}` for active and completed Searches stored in slskd, including old Searches. Each summary contains `searchId` (the UUID returned by slskd), `query`, `state`, `startedAt`, `endedAt`, `responseCount`, `fileCount`, and `lockedFileCount`. Unavailable metadata is `null`; an empty instance returns an empty array. It does not fetch Candidates.

Pass a listed `searchId` directly to `search candidates` or `transfer enqueue`. All commands use slskd's UUID as the canonical Search identifier; there is no separate CLI Search reference.

Delete a Search and its stored responses with an explicit acknowledgement:

```sh
slskd search delete '<searchId>' --yes
```

The command returns `{searchId,deleted:true}`. A missing Search returns `MISSING_SEARCH`. As with other mutations, an interrupted or timed-out request returns `AMBIGUOUS_MUTATION`; run `search list` before deciding whether to retry.

## Workflow

```sh
slskd search create --query 'artist album' --lifetime-seconds 60
slskd search candidates '<searchId>'
slskd transfer enqueue '<searchId>' '<candidateId>' --yes
slskd transfer show '<username>' '<transferId>'
```

`search create` passes the query literally to slskd. Lifetime is an integer from **5 to 300 seconds**, default **60**. For slskd 0.26.1, the CLI sends the API timeout in milliseconds because that release interprets the field in milliseconds despite describing it as seconds. The returned `searchId` is slskd's UUID, identical to the ID in `search list`. The lifetime controls response collection; completed Searches and their Candidates remain usable while slskd retains them. The CLI does not impose a separate age limit or store Search state. `search create` returns `{searchId,lifetimeSeconds}`. Previous signed CLI Search references are no longer accepted; use `search list` to obtain the canonical UUID. `search candidates` returns `{searchId,candidates:[...]}`. Each Candidate includes an opaque `candidateId`, username, remote `path`, basename `filename`, extension, byte `size`, queue length, free slot status, upload speed, available audio attributes, and `null` for unavailable metadata. Candidates are never ranked or selected by the CLI.

`transfer enqueue` accepts only the `candidateId` from the supplied Search. It rereads live slskd results, checks slskd Search availability and Candidate association, and requires the literal `--yes`. It first checks slskd's downloads for the same username, remote path, and size; a safe retry returns that Transfer with `existing:true`. A new enqueue uses slskd's batch API and returns an inspectable Transfer. If the request's network outcome is unknown, it returns `AMBIGUOUS_MUTATION` and does not retry it. Inspect slskd Transfer state before issuing another enqueue.

`transfer show` reports slskd state, normalized status (`queued`, `active`, `complete`, `failed`, `cancelled`, or `unknown`), terminal flag, progress, failure detail, and `destination`. **Known limitation:** slskd 0.26.1 does not expose the resolved path for an individual Transfer, so `destination` is `null`. Its configured download root is not necessarily the final file path. A completed slskd Transfer is reported as complete; the CLI does not verify local file contents. Observation works from any new process with the same Connection profile.

## Enqueue a release folder

A Search can return one track while the peer shares a whole release. Discover the selected Candidate's immediate folder, then inspect the returned files before choosing a selection:

```sh
slskd folder discover '<searchId>' '<candidateId>' --yes
slskd folder show '<folderRef>' --yes
slskd transfer enqueue-folder '<folderRef>' '<fileId1>' '<fileId2>' --yes
# Alternatively, enqueue every eligible file in the current folder:
slskd transfer enqueue-folder '<folderRef>' --all --yes
slskd transfer show '<username>' '<transferId>'
```

Use the `folderRef` and `fileId` values returned by discovery. These references work across CLI invocations without local Workflow state. Each discovery or refresh requests the directory from that peer and requires `--yes`; it never starts Transfers. The original Search does not need to contain every file in the directory. This uses slskd’s [peer-directory endpoint](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Users/API/Controllers/UsersController.cs), which waits for the peer’s directory response.

Enqueue refreshes the listing before selecting files. Explicit identifiers become invalid if the file's remote path or byte size changes; discover or refresh again and inspect the new selection. `--all` selects the current eligible files, including artwork and other non-audio extras. It excludes nested folders and reports ineligible files under `skipped`. Use explicit file identifiers when you want only particular tracks. Do not combine explicit identifiers with `--all`.

The result contains a `files` array with an `outcome` of `enqueued`, `existing`, `failed`, or `uncertain`, known Transfer details, and aggregate `counts`. Matching existing Transfers are returned without another enqueue. slskd controls the destination. Partial failures return `ok:false` with the per-file `result` preserved and a nonzero exit status; successful Transfers remain queued. An uncertain mutation is never automatically retried: inspect slskd using the returned Transfer identifiers and reconcile its downloads before retrying.

The directory request uses the configured per-request timeout. Unavailable peers, missing directories, and incomplete responses are errors, rather than successful empty releases.

## Watch search candidates

`search create` starts a Search and returns its canonical `searchId` immediately. To observe Candidates as slskd receives them, pass that ID to `search candidates --watch`:

```sh
slskd search create --query 'artist album' --lifetime-seconds 60
slskd search candidates '<searchId>' --watch \
  --poll-interval-ms 1000 \
  --watch-timeout-seconds 300
```

Watch mode writes one newline-delimited JSON record at a time to stdout. Success records use the existing `ok: true` envelope and `result` fields:

```json
{"ok":true,"result":{"event":"started","searchId":"<searchId>"}}
{"ok":true,"result":{"event":"candidate","searchId":"<searchId>","candidate":{"candidateId":"<candidateId>","searchId":"<searchId>","username":"peer","path":"Artist/Album/01 - Track.flac","filename":"01 - Track.flac","extension":".flac","size":12345678,"queueLength":0,"hasFreeUploadSlot":true,"uploadSpeed":1200000,"bitRate":900,"length":240,"sampleRate":44100,"bitDepth":16,"isVariableBitRate":false,"isLocked":false}}}
{"ok":true,"result":{"event":"ended","searchId":"<searchId>","reason":"completed","candidateCount":1}}
```

The event types are `started`, `candidate`, and `ended`. Each candidate record contains the full normalized Candidate. `candidateCount` counts distinct Candidate identifiers emitted during this invocation. Repeated or reordered slskd snapshots do not emit the same Candidate twice, and metadata changes for an already emitted Candidate do not produce update records. A new watch has no saved cursor: it replays Candidates currently available from slskd and deduplicates only within that invocation.

`--poll-interval-ms` accepts **100–60,000** and defaults to **1,000**. `--watch-timeout-seconds` accepts **1–3,600** and defaults to **300**. The watch timeout bounds the complete observation, including requests. When slskd reports the Search's `Completed` state, the CLI fetches one final response snapshot, emits any new Candidates, then ends with `reason: "completed"`. slskd 0.26.1 serializes Search states as enum names; `Completed` is the collection-terminal flag and may appear with a reason such as `TimedOut`, `Cancelled`, or `Errored`. The upstream [`Search` model](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Search/Types/Search.cs), [Search API controller](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Search/API/Controllers/SearchesController.cs), and [`SearchStates` enum](https://github.com/jpdillingham/Soulseek.NET/blob/10.0.2/src/SearchStates.cs) define this contract. An Expired or missing Search is an error, not normal collection completion.

If the observation deadline arrives first, watch mode emits `ended` with `reason: "deadline"` and exits successfully. That means observation ended at its configured bound; it does not mean slskd finished collecting responses. A remote or request failure emits one `ok: false` error record and a nonzero exit status, with no successful `ended` record afterward. SIGINT and SIGTERM stop observation with exit status **130** and **143**, respectively, and do not emit a successful end event. If the stdout consumer closes the pipe, observation stops cleanly. Watch mode is read-only: it does not create, cancel, delete, rank, select, or enqueue anything.

Select a Candidate explicitly from the stream before enqueueing it. For example, after reviewing the `candidate` records, use the chosen values in the existing workflow:

```sh
slskd transfer enqueue '<searchId>' '<candidateId chosen from the candidate event>' --yes
slskd transfer show '<username from that candidate>' '<transferId>'
```

Without `--watch`, `search candidates '<searchId>'` remains a single JSON result containing the current `{searchId,candidates:[...]}` snapshot.

## Transfer mutations

```sh
slskd transfer cancel '<username>' '<transferId>' --yes
slskd transfer clear --yes
slskd transfer delete '<username>' '<transferId>' --yes
```

Every mutation needs its own literal `--yes`. `cancel` leaves completed or already cancelled Transfers unchanged. `clear` invokes slskd's **global clear completed downloads** endpoint. `delete` removes one Transfer record through slskd's `remove=true` endpoint, which may cancel an active Transfer first. These commands do not act on downloaded files.

## Exit codes

| Exit | Meaning                                                             | Error codes                                                                                                                      |
| ---: | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
|    0 | Success                                                             | —                                                                                                                                |
|    2 | Invalid input or acknowledgement                                    | `INVALID_INPUT`, `INVALID_CONFIG`, `INVALID_CANDIDATE`, `ACKNOWLEDGEMENT_REQUIRED`                                               |
|    3 | Missing Connection values                                           | `MISSING_CONFIGURATION`                                                                                                          |
|    4 | Authentication or key permissions                                   | `AUTHENTICATION`                                                                                                                 |
|    5 | Unsupported or unreadable slskd version                             | `INCOMPATIBLE`                                                                                                                   |
|    6 | Connection failure                                                  | `CONNECTION`                                                                                                                     |
|    7 | Remote error, missing/expired Search or Candidate, missing Transfer | `REMOTE`, `MISSING_SEARCH`, `EXPIRED_SEARCH`, `MISSING_CANDIDATE`, `TRANSFER_NOT_FOUND`, `UNAVAILABLE_FOLDER`, `PARTIAL_ENQUEUE` |
|    8 | Read request timeout                                                | `TIMEOUT`                                                                                                                        |
|    9 | Unknown mutation outcome                                            | `AMBIGUOUS_MUTATION`                                                                                                             |
|  130 | SIGINT during watch observation                                     | —                                                                                                                                |
|  143 | SIGTERM during watch observation                                    | —                                                                                                                                |

An unknown mutation outcome uses exit 9 and `AMBIGUOUS_MUTATION`, including a timeout after sending a mutation. The CLI does not retry state-changing requests automatically.
